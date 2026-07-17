// Platform-independent filesystem primitives: idempotent, dry-run-aware tree
// writes that record a status per action. `installTree` is what `commands/start.ts`
// uses to materialize an agent's generated extensions. No brew/mise/macOS here,
// so they're unit-tested on any OS.

import { chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { getErrorMessage, hasErrorCode } from './utils.js';

type SetupStatus = 'changed' | 'failed' | 'unchanged';

interface SetupResult {
  readonly name: string;
  readonly detail: string;
  readonly status: SetupStatus;
}

export interface InstallContext {
  readonly dryRun: boolean;
  readonly results: SetupResult[];
  readonly failures: string[];
}

export interface TreeFile {
  readonly rel: string;
  readonly content: string;
  readonly mode?: number;
}

export function addResult(ctx: InstallContext, name: string, detail: string, status: SetupStatus): void {
  ctx.results.push({ name, detail, status });
}

export function fail(ctx: InstallContext, name: string, detail: string): void {
  ctx.failures.push(`${name}: ${detail}`);
  addResult(ctx, name, detail, 'failed');
}

/** Replace the `dest` directory tree with the bundled `files`, cleaning extras. */
export async function installTree(
  ctx: InstallContext,
  name: string,
  dest: string,
  files: readonly TreeFile[]
): Promise<void> {
  try {
    if (await treeMatches(dest, files)) {
      addResult(ctx, name, dest, 'unchanged');
      return;
    }
    if (ctx.dryRun) {
      addResult(ctx, name, `would replace ${dest}`, 'changed');
      return;
    }
    await makeWritableTree(dest);
    await rm(dest, { force: true, recursive: true });
    for (const file of files) await writeTreeFile(dest, file);
    addResult(ctx, name, dest, 'changed');
  } catch (error) {
    fail(ctx, name, getErrorMessage(error));
  }
}

async function writeTreeFile(dest: string, file: TreeFile): Promise<void> {
  const target = join(dest, file.rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, file.content, 'utf8');
  if (file.mode !== undefined) {
    await chmod(target, file.mode);
  }
}

async function treeMatches(dest: string, files: readonly TreeFile[]): Promise<boolean> {
  const actual = await listFilesRel(dest);
  if (actual.length !== files.length) {
    return false;
  }
  const actualSet = new Set(actual);
  for (const file of files) {
    if (!actualSet.has(file.rel)) return false;
    if ((await readTextIfExists(join(dest, file.rel))) !== file.content) return false;
  }
  return true;
}

async function listFilesRel(dir: string, base: string = dir): Promise<string[]> {
  const info = await lstatIfExists(dir);
  if (!info || !info.isDirectory()) {
    return [];
  }
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRel(full, base)));
    else out.push(relative(base, full));
  }
  return out;
}

async function makeWritableTree(path: string): Promise<void> {
  const info = await lstatIfExists(path);
  if (!info || info.isSymbolicLink()) {
    return;
  }
  await chmod(path, info.isDirectory() ? 0o755 : 0o644);
  if (!info.isDirectory()) {
    return;
  }
  const entries = await readdir(path);
  await Promise.all(entries.map(entry => makeWritableTree(join(path, entry))));
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}
