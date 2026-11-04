import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTree, readTextIfExists, type TreeFile } from './install.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cradle-install-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tree: TreeFile[] = [
  { rel: 'top.md', content: 'top\n' },
  { rel: 'nested/file.md', content: 'nested\n' }
];

describe('installTree', () => {
  it('writes every file, including nested paths', async () => {
    const dest = join(dir, 'out');
    await installTree(dest, tree);
    expect(await readFile(join(dest, 'top.md'), 'utf8')).toBe('top\n');
    expect(await readFile(join(dest, 'nested', 'file.md'), 'utf8')).toBe('nested\n');
  });

  it('is a no-op when the tree already matches, rewriting nothing', async () => {
    const dest = join(dir, 'out');
    await installTree(dest, tree);
    const before = await stat(join(dest, 'top.md'));

    await installTree(dest, tree);

    // Nothing was rewritten, so the original inode timestamps survive — the proof the
    // match check short-circuits instead of re-writing identical content.
    expect(await stat(join(dest, 'top.md'))).toMatchObject({ mtimeMs: before.mtimeMs, ino: before.ino });
    expect(await readFile(join(dest, 'top.md'), 'utf8')).toBe('top\n');
  });

  it('rewrites a file whose content drifted', async () => {
    const dest = join(dir, 'out');
    await installTree(dest, tree);
    await writeFile(join(dest, 'top.md'), 'edited\n', 'utf8');

    await installTree(dest, tree);

    expect(await readFile(join(dest, 'top.md'), 'utf8')).toBe('top\n');
  });

  it('removes files that are not part of the tree', async () => {
    const dest = join(dir, 'out');
    await installTree(dest, tree);
    await writeFile(join(dest, 'stray.txt'), 'remove me\n', 'utf8');

    await installTree(dest, tree);

    expect(await readdir(dest)).not.toContain('stray.txt');
    expect(await readdir(dest).then(entries => entries.sort())).toEqual(['nested', 'top.md']);
  });

  it('replaces a read-only destination tree (makeWritableTree clears perms first)', async () => {
    const dest = join(dir, 'out');
    await installTree(dest, tree);
    await chmod(join(dest, 'nested', 'file.md'), 0o400);
    await chmod(join(dest, 'nested'), 0o500);

    await installTree(dest, [{ rel: 'only.md', content: 'fresh\n' }]);

    expect(await readdir(dest)).toEqual(['only.md']);
    expect(await readFile(join(dest, 'only.md'), 'utf8')).toBe('fresh\n');
  });

  it('throws rather than swallowing an unwritable destination', async () => {
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, '', 'utf8');
    const dest = join(blocker, 'dest');
    await expect(installTree(dest, [{ rel: 'a.txt', content: 'x' }])).rejects.toThrow(dest);
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
