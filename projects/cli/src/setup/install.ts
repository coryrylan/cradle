// Platform-independent filesystem primitive: replace a directory tree with the given
// files, removing anything the tree does not contain. `installTree` is what
// `commands/run.ts` uses to materialize an agent's generated extensions. No
// brew/mise/macOS here, so they're unit-tested on any OS.

import { chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { hasErrorCode } from './utils.js';

export interface TreeFile {
  readonly rel: string;
  readonly content: string;
}

/**
 * Replace the `dest` tree with `files`: a no-op when the tree already matches byte for
 * byte, otherwise a rewrite that drops anything `files` does not name. fs errors
 * propagate untouched so the caller names the artifact it failed on.
 */
export async function installTree(dest: string, files: readonly TreeFile[]): Promise<void> {
  if (await treeMatches(dest, files)) return;
  await makeWritableTree(dest);
  await rm(dest, { force: true, recursive: true });
  for (const file of files) await writeTreeFile(dest, file);
}

async function writeTreeFile(dest: string, file: TreeFile): Promise<void> {
  const target = join(dest, file.rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, file.content, 'utf8');
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
