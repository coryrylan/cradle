// Resolves the real git dir for linked worktrees and submodule checkouts,
// whose `.git` is a pointer file rather than a directory (see `resolveLinkedGitDir`).

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isAncestorOrSelf } from './profiles.js';

const GITDIR_PREFIX = 'gitdir:';

/** Read `path` as utf8 text; `undefined` on ANY error (ENOENT: no such file; EISDIR: a real `.git` directory, not a pointer file). */
async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * A linked git worktree or a submodule checkout stores `.git` as a pointer
 * FILE (`gitdir: /abs/path/to/main/.git/worktrees/<name>`) rather than a
 * directory — the real git dir lives outside `cwd`. A sandboxed run only
 * grants `cwd`, so without this resolved dir every git command inside the
 * sandbox (including project hooks that shell out to `git rev-parse`) fails
 * with `fatal: not a git repository`. Returns `undefined` for a regular
 * repo (`.git` is a directory already covered by the cwd grant), a missing
 * repo, a malformed pointer, or a pointer that already resolves inside `cwd`.
 */
export async function resolveLinkedGitDir(cwd: string): Promise<string | undefined> {
  const pointer = await readTextIfPresent(join(cwd, '.git'));
  if (pointer === undefined || !pointer.startsWith(GITDIR_PREFIX)) return undefined;
  const gitDir = resolve(cwd, pointer.slice(GITDIR_PREFIX.length).trim());
  const commondir = await readTextIfPresent(join(gitDir, 'commondir'));
  const sharedDir = commondir !== undefined ? resolve(gitDir, commondir.trim()) : gitDir;
  return isAncestorOrSelf(cwd, sharedDir) ? undefined : sharedDir;
}
