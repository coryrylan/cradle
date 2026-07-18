import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveLinkedGitDir } from './linked-git-dir.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cradle-linked-git-dir-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveLinkedGitDir', () => {
  it('should return undefined for a regular repo whose .git is a directory', async () => {
    const cwd = join(root, 'repo');
    await mkdir(join(cwd, '.git'), { recursive: true });
    expect(await resolveLinkedGitDir(cwd)).toBeUndefined();
  });

  it('should return undefined when there is no .git at all', async () => {
    const cwd = join(root, 'plain');
    await mkdir(cwd, { recursive: true });
    expect(await resolveLinkedGitDir(cwd)).toBeUndefined();
  });

  it('should resolve an absolute gitdir pointer with a commondir to the main repo git dir', async () => {
    const cwd = join(root, 'wt');
    const worktreeGitDir = join(root, 'main', '.git', 'worktrees', 'wt');
    await mkdir(cwd, { recursive: true });
    await mkdir(worktreeGitDir, { recursive: true });
    await writeFile(join(worktreeGitDir, 'commondir'), '../..\n', 'utf8');
    await writeFile(join(cwd, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8');
    expect(await resolveLinkedGitDir(cwd)).toBe(join(root, 'main', '.git'));
  });

  it('should resolve to the gitdir itself when there is no commondir (submodule layout)', async () => {
    const cwd = join(root, 'super', 'sub');
    const submoduleGitDir = join(root, 'super', '.git', 'modules', 'sub');
    await mkdir(cwd, { recursive: true });
    await mkdir(submoduleGitDir, { recursive: true });
    await writeFile(join(cwd, '.git'), `gitdir: ${submoduleGitDir}`, 'utf8');
    expect(await resolveLinkedGitDir(cwd)).toBe(submoduleGitDir);
  });

  it('should resolve a relative gitdir pointer against cwd', async () => {
    const cwd = join(root, 'wt');
    const worktreeGitDir = join(root, 'main', '.git', 'worktrees', 'wt');
    await mkdir(cwd, { recursive: true });
    await mkdir(worktreeGitDir, { recursive: true });
    await writeFile(join(cwd, '.git'), 'gitdir: ../main/.git/worktrees/wt\n', 'utf8');
    expect(await resolveLinkedGitDir(cwd)).toBe(worktreeGitDir);
  });

  it('should use an absolute commondir path as-is', async () => {
    const cwd = join(root, 'wt');
    const worktreeGitDir = join(root, 'main', '.git', 'worktrees', 'wt');
    const mainGitDir = join(root, 'main', '.git');
    await mkdir(cwd, { recursive: true });
    await mkdir(worktreeGitDir, { recursive: true });
    await writeFile(join(worktreeGitDir, 'commondir'), mainGitDir, 'utf8');
    await writeFile(join(cwd, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8');
    expect(await resolveLinkedGitDir(cwd)).toBe(mainGitDir);
  });

  it('should return undefined for malformed .git content with no gitdir: prefix', async () => {
    const cwd = join(root, 'malformed');
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, '.git'), 'not a pointer file\n', 'utf8');
    expect(await resolveLinkedGitDir(cwd)).toBeUndefined();
  });

  it('should return undefined when the pointer resolves inside cwd itself', async () => {
    const cwd = join(root, 'self');
    const nestedGitDir = join(cwd, 'nested', 'gitdir');
    await mkdir(nestedGitDir, { recursive: true });
    await writeFile(join(cwd, '.git'), `gitdir: ${nestedGitDir}\n`, 'utf8');
    expect(await resolveLinkedGitDir(cwd)).toBeUndefined();
  });
});
