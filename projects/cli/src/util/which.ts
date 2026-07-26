import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type WhichFn = (bin: string) => string | null;

/**
 * mise installs cradle's managed tools (nono, pi, …) as shims under
 * `~/.local/share/mise/shims`. Under the default `mise activate` (hook-env)
 * setup that directory isn't on PATH, and a freshly installed tool isn't on the
 * running process's PATH until the next prompt — so right after a `mise install`
 * a plain PATH lookup misses it. Resolve the shim directly so `run`/`doctor`
 * see tools mise just installed. Returns the shim path or `null` when absent.
 */
export function miseShimPath(bin: string, home: string = homedir()): string | null {
  const shim = join(home, '.local', 'share', 'mise', 'shims', bin);
  return existsSync(shim) ? shim : null;
}

const defaultWhich: WhichFn = bin => Bun.which(bin) ?? miseShimPath(bin);

/** A `WhichFn` backed by a static table — the shared PATH-lookup double for in-process tests. */
export function createWhichStub(table: Record<string, string>): WhichFn {
  return bin => table[bin] ?? null;
}

/** Resolve an executable on PATH (or in mise's shims), returning its path or `null` when absent. */
export function lookupBin(bin: string, which: WhichFn = defaultWhich): string | null {
  return which(bin);
}

/**
 * Resolve an executable on PATH or throw a friendly error pointing the user at
 * `cradle doctor`. Returns the resolved path on success.
 */
export function requireBin(bin: string, which: WhichFn = defaultWhich): string {
  const path = lookupBin(bin, which);
  if (!path) {
    throw new Error(
      `Required executable "${bin}" not found on PATH — install it, then run \`cradle doctor\` to verify`
    );
  }
  return path;
}
