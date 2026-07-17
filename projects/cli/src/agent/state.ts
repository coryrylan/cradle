// Per-agent runtime state lives outside the (portable, committable) agent
// folder: generated pi extensions and session history go under
// `~/.cradle/agents/<basename>-<hash>/`. The hash keys the absolute folder
// path so two agents with the same basename never collide.

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export interface StatePaths {
  readonly extensionsDir: string;
  readonly sessionsDir: string;
}

/** Stable, readable id for an agent folder: sanitized basename + 8-hex path hash. */
export function agentId(absDir: string): string {
  const name = basename(absDir)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const hash = createHash('sha256').update(absDir).digest('hex').slice(0, 8);
  return `${name === '' ? 'agent' : name}-${hash}`;
}

/** Where an agent's runtime state lives. Override the root via `CRADLE_STATE_DIR` (or the `stateRoot` param). */
export function stateDirFor(
  absDir: string,
  home: string = homedir(),
  stateRoot: string | undefined = process.env.CRADLE_STATE_DIR
): string {
  // `||` on purpose: an empty CRADLE_STATE_DIR must fall back to ~/.cradle,
  // not become a cwd-relative state root that the sandbox profile then grants.
  const root = stateRoot || join(home, '.cradle');
  return join(root, 'agents', agentId(absDir));
}

export function statePaths(stateDir: string): StatePaths {
  return {
    extensionsDir: join(stateDir, 'extensions'),
    sessionsDir: join(stateDir, 'sessions')
  };
}
