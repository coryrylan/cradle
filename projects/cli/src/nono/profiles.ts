import { basename } from 'node:path';
import type { AgentNetwork, AgentSandboxGrants } from '../agent/folder.js';
import cradlePiProfile from './cradle-pi.json' with { type: 'json' };

/** Filename of the generated per-agent nono profile, written into the agent's state dir. */
export const AGENT_PROFILE_FILE = 'nono-profile.json';

/** Expand a leading `~` or `$HOME` against `home`; other paths pass through unchanged. */
export function expandHome(path: string, home: string): string {
  if (path === '~' || path === '$HOME') return home;
  if (path.startsWith('~/')) return `${home}${path.slice(1)}`;
  if (path.startsWith('$HOME/')) return `${home}${path.slice('$HOME'.length)}`;
  return path;
}

export interface ProfileSpec {
  readonly home: string;
  /** pi's working dir (the target project) — granted read+write. */
  readonly cwd: string;
  /** The portable agent folder — granted read. */
  readonly agentDir: string;
  /** The agent's per-agent state dir — granted read+write, and where this profile is written. */
  readonly stateDir: string;
  /** Extra grants from the agent folder's `sandbox/nono.json`. */
  readonly grants: AgentSandboxGrants;
  /** Raw Seatbelt s-expr rules from the agent's `sandbox/nono.json`, merged after the base's. */
  readonly rules: readonly string[];
  /** Precedence-resolved network posture, emitted as the profile's `network` block. Absent ⇒ nono default (open). */
  readonly network?: AgentNetwork;
}

type BaseFilesystem = {
  readonly read?: readonly string[];
  readonly write?: readonly string[];
  readonly allow?: readonly string[];
};

/**
 * Build the per-agent nono profile: the embedded `cradle-pi` base (which
 * `extends default`, pulls the `node_runtime` group, and grants mise/pi/say
 * paths) merged with this run's grants — the target cwd, the agent folder, the
 * state dir, and the agent's own `sandbox/nono.json` entries. Regenerated every
 * run into the state dir, so there is no shared global profile: each agent's
 * permissions are fully described by its own directory.
 *
 * `meta.name` is derived from the state-dir basename so every agent gets a
 * distinct profile identity (no cross-agent collisions in nono's state).
 * `~`/`$HOME` in the agent's grants are expanded here; base entries keep their
 * `$HOME` form (nono expands those). Net posture stays a `nono run` flag.
 *
 * The agent's `unsafe_macos_seatbelt_rules` are appended AFTER the base's rules:
 * Seatbelt is last-match-wins, so a later agent rule can widen (or override) a
 * base allow, never the reverse.
 *
 * The resolved `network` posture is emitted as the profile's `network` block
 * (nono's canonical key names). Absent ⇒ no `network` block ⇒ nono default
 * (open). nono enforces it — including failing closed on a bad key or an
 * unenforceable platform — so there is no cradle-side fallback here.
 */
export function buildProfileJson(spec: ProfileSpec): string {
  const expand = (path: string): string => expandHome(path, spec.home);
  const baseFs: BaseFilesystem = cradlePiProfile.filesystem;
  const network = spec.network !== undefined ? toNonoNetwork(spec.network) : undefined;
  const profile = {
    ...cradlePiProfile,
    meta: { ...cradlePiProfile.meta, name: `cradle-${basename(spec.stateDir)}` },
    filesystem: {
      ...baseFs,
      read: [...(baseFs.read ?? []), spec.agentDir, ...spec.grants.read.map(expand)],
      write: [...(baseFs.write ?? []), ...spec.grants.write.map(expand)],
      allow: [...(baseFs.allow ?? []), spec.cwd, spec.stateDir, ...spec.grants.allow.map(expand)]
    },
    unsafe_macos_seatbelt_rules: [...(cradlePiProfile.unsafe_macos_seatbelt_rules ?? []), ...spec.rules],
    ...(network !== undefined ? { network } : {})
  };
  return JSON.stringify(profile, null, 2);
}

/** Map `AgentNetwork` (camelCase) to nono's canonical snake_case `network` block, dropping absent fields. */
function toNonoNetwork(net: AgentNetwork): Record<string, unknown> {
  return {
    ...(net.block !== undefined ? { block: net.block } : {}),
    ...(net.networkProfile !== undefined ? { network_profile: net.networkProfile } : {}),
    ...(net.allowDomain !== undefined ? { allow_domain: net.allowDomain } : {}),
    ...(net.openPort !== undefined ? { open_port: net.openPort } : {}),
    ...(net.listenPort !== undefined ? { listen_port: net.listenPort } : {})
  };
}
