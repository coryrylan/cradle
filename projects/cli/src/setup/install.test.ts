import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addResult, fail, installTree, readTextIfExists, type InstallContext, type TreeFile } from './install.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cradle-install-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(dryRun = false): InstallContext {
  return { dryRun, results: [], failures: [] };
}
const last = (context: InstallContext) => context.results.at(-1);

describe('addResult / fail', () => {
  it('records results and failures', () => {
    const context = ctx();
    addResult(context, 'a', 'ok', 'unchanged');
    fail(context, 'b', 'broke');
    expect(context.results).toHaveLength(2);
    expect(context.failures).toEqual(['b: broke']);
    expect(last(context)?.status).toBe('failed');
  });
});

describe('installTree', () => {
  const tree: TreeFile[] = [
    { rel: 'top.md', content: 'top\n' },
    { rel: 'nested/script.sh', content: 'echo hi\n', mode: 0o755 }
  ];

  it('writes every file, applies modes, and is idempotent', async () => {
    const dest = join(dir, 'out');
    const context = ctx();
    await installTree(context, 'tree', dest, tree);
    expect(await readFile(join(dest, 'top.md'), 'utf8')).toBe('top\n');
    expect((await stat(join(dest, 'nested/script.sh'))).mode & 0o111).not.toBe(0);

    await installTree(context, 'tree', dest, tree);
    expect(last(context)?.status).toBe('unchanged');
  });

  it('removes files that are not part of the tree', async () => {
    const dest = join(dir, 'out');
    await installTree(ctx(), 'tree', dest, tree);
    await writeFile(join(dest, 'stray.txt'), 'remove me\n', 'utf8');

    const context = ctx();
    await installTree(context, 'tree', dest, tree);
    expect(last(context)?.status).toBe('changed');
    expect(await readdir(dest)).not.toContain('stray.txt');
  });

  it('does not touch disk on a dry run', async () => {
    const dest = join(dir, 'out');
    const context = ctx(true);
    await installTree(context, 'tree', dest, tree);
    expect(await readTextIfExists(join(dest, 'top.md'))).toBeUndefined();
    expect(last(context)?.detail).toContain('would replace');
  });

  it('replaces a read-only destination tree (makeWritableTree clears perms first)', async () => {
    const dest = join(dir, 'out');
    await installTree(ctx(), 'tree', dest, tree);
    await chmod(join(dest, 'nested', 'script.sh'), 0o400);
    await chmod(join(dest, 'nested'), 0o500);

    const context = ctx();
    await installTree(context, 'tree', dest, [{ rel: 'only.md', content: 'fresh\n' }]);
    expect(last(context)?.status).toBe('changed');
    expect(await readdir(dest)).toEqual(['only.md']);
  });
});

describe('readTextIfExists', () => {
  it('returns content or undefined for a missing file', async () => {
    const path = join(dir, 'x.txt');
    expect(await readTextIfExists(path)).toBeUndefined();
    await writeFile(path, 'hi', 'utf8');
    expect(await readTextIfExists(path)).toBe('hi');
  });
});

describe('failure recording (warn-and-record, never throw)', () => {
  it('records a failure when installTree cannot replace the destination', async () => {
    const blocker = join(dir, 'blocker2');
    await writeFile(blocker, '', 'utf8');
    const context = ctx();
    await installTree(context, 'tree', join(blocker, 'dest'), [{ rel: 'a.txt', content: 'x' }]);
    expect(context.failures).toHaveLength(1);
    expect(last(context)?.status).toBe('failed');
  });
});
