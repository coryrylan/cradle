// Composes argv arrays and mount lists for the Docker Sandboxes (`sbx`)
// backend — cradle's second sandbox backend alongside nono (see
// `nono/profiles.ts`). Pure composition: no I/O, no spawning, no process
// state. `commands/run.ts` wires this in (a later task).

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { AgentNetwork, AgentSandboxGrants } from '../agent/folder.js';
import { expandHome } from '../nono/profiles.js';

/**
 * Guest `localhost` resolves to the microVM itself, not the host — host
 * loopback is reachable at this gateway, which sbx routes through the policy
 * proxy. Used both to rewrite `allowDomain` localhost entries (see
 * `composeSbxPolicyArgvs`) and caller-supplied base URLs (see
 * `rewriteLocalhostBaseUrl`).
 */
export const SBX_HOST_GATEWAY = 'host.docker.internal';

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const IPV4_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;
const LOCALHOST_ENTRIES = new Set(['localhost', '127.0.0.1']);

/** A single sbx mount: a host path (preserved verbatim in the guest) and its access mode. */
export interface SbxMount {
  readonly path: string;
  readonly readonly: boolean;
}

/**
 * Everything `composeSbxCreateArgv`, `composeSbxPolicyArgvs`,
 * `composeSbxProvisionArgv`, and `composeSbxExecArgv` need — the sbx analog of
 * nono's `ProfileSpec`.
 */
export interface SbxSpec {
  /** Resolved path, or bare `sbx` for dry-run previews. */
  readonly sbxBin: string;
  /** Sandbox name from `sbxSandboxName()`. */
  readonly name: string;
  /** The target project — always the first (rw) workspace mount. */
  readonly cwd: string;
  /** Host home dir — for the exec `HOME` override and the `~/.pi/agent` mount. */
  readonly home: string;
  /** From `composeSbxMounts()`; cwd first. Fixed at sandbox creation time. */
  readonly mounts: readonly SbxMount[];
  /** Precedence-resolved network posture — the same shape nono consumes. */
  readonly network?: AgentNetwork;
  /** Host pi version to pin in-guest; `null` = install only if missing. */
  readonly piVersion: string | null;
  /** Pass `-t` on exec — set when a TTY is present. */
  readonly tty: boolean;
}

/** Inputs to `composeSbxMounts` — everything that can contribute a guest mount. */
export interface SbxMountContext {
  readonly cwd: string;
  readonly agentDir: string;
  readonly stateDir: string;
  readonly home: string;
  readonly grants: AgentSandboxGrants;
  /**
   * The real git dir when `cwd` is a linked worktree or submodule checkout
   * (see `agent/linked-git-dir.ts`) — mirrors nono's `ProfileSpec.linkedGitDir`.
   * Absent for regular repos, where `.git` already sits inside the cwd mount.
   */
  readonly linkedGitDir?: string;
}

/**
 * Build this run's guest mount list: cwd (rw), the agent folder (ro), the
 * state dir (rw), `~/.pi/agent` (rw — pi's auth/settings store; the exec
 * `HOME` override in `composeSbxExecArgv` makes pi find it there), the linked
 * git dir when present (rw), then the agent's own `sandbox/nono.json` grants
 * (`read` ro, `write`/`allow` rw), each expanded against `home`. Duplicate
 * paths collapse to one entry — rw wins over ro, first-occurrence order
 * otherwise — since sbx takes a flat mount list, not layered grants.
 */
export function composeSbxMounts(ctx: SbxMountContext): SbxMount[] {
  const expand = (path: string): string => expandHome(path, ctx.home);
  const candidates: SbxMount[] = [
    { path: ctx.cwd, readonly: false },
    { path: ctx.agentDir, readonly: true },
    { path: ctx.stateDir, readonly: false },
    { path: join(ctx.home, '.pi', 'agent'), readonly: false },
    ...(ctx.linkedGitDir !== undefined ? [{ path: ctx.linkedGitDir, readonly: false }] : []),
    ...ctx.grants.read.map(path => ({ path: expand(path), readonly: true })),
    ...ctx.grants.write.map(path => ({ path: expand(path), readonly: false })),
    ...ctx.grants.allow.map(path => ({ path: expand(path), readonly: false }))
  ];
  return dedupeMounts(candidates);
}

function dedupeMounts(mounts: readonly SbxMount[]): SbxMount[] {
  const order: string[] = [];
  const readonlyByPath = new Map<string, boolean>();
  for (const mount of mounts) {
    if (!readonlyByPath.has(mount.path)) order.push(mount.path);
    if (readonlyByPath.get(mount.path) !== false) readonlyByPath.set(mount.path, mount.readonly);
  }
  return order.map(path => ({ path, readonly: readonlyByPath.get(path) === true }));
}

/**
 * `cradle-<stateDirBasename>-<hash8>` — hash8 is the first 8 hex chars of a
 * sha256 over the order-insensitive sorted `path:ro|rw` strings, mirroring
 * `agentId` (`agent/state.ts`). Mounts are fixed at sbx creation time, so this
 * name keys the mount set: a changed mount set yields a new sandbox name
 * instead of silently attaching to (and running with) a stale mount list.
 */
export function sbxSandboxName(stateDirBasename: string, mounts: readonly SbxMount[]): string {
  const key = mounts
    .map(mount => `${mount.path}:${mount.readonly ? 'ro' : 'rw'}`)
    .sort()
    .join('|');
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 8);
  return `cradle-${stateDirBasename}-${hash}`;
}

/** `sbx create shell <path>[:ro]... --name <name> -q`. `spec.mounts` already carries cwd first. */
export function composeSbxCreateArgv(spec: SbxSpec): string[] {
  const paths = spec.mounts.map(mount => (mount.readonly ? `${mount.path}:ro` : mount.path));
  return [spec.sbxBin, 'create', 'shell', ...paths, '--name', spec.name, '-q'];
}

/**
 * Expand `allowDomain` entries into sbx policy resources. A bare domain
 * expands to `d,*.d` — sbx matches the exact host and its subdomains as
 * disjoint resources, so both are needed for one logical allow. Raw IPv4s
 * stay bare (no `*.` form). `localhost`/`127.0.0.1` are dropped and replaced
 * by a single `host.docker.internal` resource — guest loopback never
 * traverses the policy proxy, and host loopback is reached via the gateway —
 * deduped when both localhost forms appear.
 */
function composeAllowResources(allowDomain: readonly string[]): string[] {
  const resources: string[] = [];
  let includesGateway = false;
  for (const domain of allowDomain) {
    if (LOCALHOST_ENTRIES.has(domain)) {
      includesGateway = true;
    } else if (IPV4_PATTERN.test(domain)) {
      resources.push(domain);
    } else {
      resources.push(domain, `*.${domain}`);
    }
  }
  if (includesGateway) resources.push(SBX_HOST_GATEWAY);
  return resources;
}

/**
 * Per-sandbox network policy argvs (idempotent re-adds — safe to run every
 * launch). `[]` when `spec.network` is absent. A `block: true` posture emits a
 * single deny-all — `allowDomain` is ignored under block, matching nono's
 * block-wins precedence, since a same-scope deny always beats an allow.
 * Otherwise, a non-empty `allowDomain` emits a single allow argv with every
 * expanded resource comma-joined (see `composeAllowResources`); an empty or
 * absent `allowDomain` under a non-blocking posture emits nothing.
 * `openPort`/`listenPort`/`networkProfile` have no sbx policy equivalent —
 * see `sbxNetworkWarnings` for their disclosures.
 */
export function composeSbxPolicyArgvs(spec: SbxSpec): string[][] {
  const { network, sbxBin, name } = spec;
  if (network === undefined) return [];
  if (network.block === true) return [[sbxBin, 'policy', 'deny', 'network', '--sandbox', name, '**']];
  const resources = composeAllowResources(network.allowDomain ?? []);
  return resources.length > 0 ? [[sbxBin, 'policy', 'allow', 'network', '--sandbox', name, resources.join(',')]] : [];
}

function networkProfileWarning(network: AgentNetwork): string | undefined {
  return network.networkProfile !== undefined
    ? 'network_profile is nono-only — ignored under the sbx backend'
    : undefined;
}

function portWarning(network: AgentNetwork): string | undefined {
  const hasPorts = (network.openPort?.length ?? 0) > 0 || (network.listenPort?.length ?? 0) > 0;
  return hasPorts
    ? 'open_port/listen_port are nono-only — guest-local ports are unrestricted and host services are reachable via host.docker.internal under sbx'
    : undefined;
}

function allowDomainWarning(network: AgentNetwork): string | undefined {
  const isAllowlist = network.block !== true && (network.allowDomain?.length ?? 0) > 0;
  return isAllowlist
    ? 'sbx allow rules add to your global sbx policy but cannot subtract from it — run `sbx policy init deny-all` for strict allowlist semantics (nono enforces the allowlist exactly)'
    : undefined;
}

/**
 * Warn-and-drop disclosures for `AgentNetwork` fields sbx cannot enforce the
 * way nono does. Returns `[]` when nothing applies (including when `network`
 * is absent) — this module never throws, it only reports what it dropped.
 */
export function sbxNetworkWarnings(network: AgentNetwork | undefined): string[] {
  if (network === undefined) return [];
  return [networkProfileWarning(network), portWarning(network), allowDomainWarning(network)].filter(
    (warning): warning is string => warning !== undefined
  );
}

/** Warn-and-drop disclosure for the one `AgentSandboxGrants` field sbx cannot honor: Unix sockets cannot cross the VM boundary. */
export function sbxGrantWarnings(grants: AgentSandboxGrants): string[] {
  return grants.unixSocketDirBind.length > 0
    ? ['unix_socket_dir_bind is nono-only — Unix sockets cannot cross the sbx VM boundary; grant ignored']
    : [];
}

/**
 * `sbx exec <name> bash -lc <script>` running an idempotent pi install: with
 * `spec.piVersion` pinned, reinstalls only on a version mismatch (`pi
 * --version` compared against the pin); with `null`, installs only if `pi` is
 * missing from PATH entirely, otherwise leaving whatever version is already
 * there.
 */
export function composeSbxProvisionArgv(spec: SbxSpec): string[] {
  const script =
    spec.piVersion === null
      ? `command -v pi >/dev/null 2>&1 || npm i -g ${PI_PACKAGE}`
      : `command -v pi >/dev/null 2>&1 && [ "$(pi --version 2>/dev/null)" = "${spec.piVersion}" ] || npm i -g ${PI_PACKAGE}@${spec.piVersion}`;
  return [spec.sbxBin, 'exec', spec.name, 'bash', '-lc', script];
}

/**
 * `sbx exec -i [-t] -e HOME=<home> -w <cwd> <name> <piArgv...>` — docker-exec
 * semantics. `-t` rides only when `spec.tty` is set (a TTY is present);
 * forcing it without one breaks non-interactive callers.
 */
export function composeSbxExecArgv(spec: SbxSpec, piArgv: readonly string[]): string[] {
  return [
    spec.sbxBin,
    'exec',
    '-i',
    ...(spec.tty ? ['-t'] : []),
    '-e',
    `HOME=${spec.home}`,
    '-w',
    spec.cwd,
    spec.name,
    ...piArgv
  ];
}

/** True when `stderr` reports the sandbox name is already taken — callers treat that as attach, not failure. */
export function isSbxAlreadyExistsError(stderr: string): boolean {
  return stderr.toLowerCase().includes('already exists');
}

/**
 * Rewrite a `localhost`/`127.0.0.1` base URL to `SBX_HOST_GATEWAY`, preserving
 * scheme, port, and path — a host service bound to loopback is unreachable
 * from inside the sbx guest microVM under its own name, but the gateway
 * routes through the policy proxy back to the host. Any other host, and a
 * parse failure, pass through unchanged.
 */
export function rewriteLocalhostBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return baseUrl;
  url.hostname = SBX_HOST_GATEWAY;
  return url.toString();
}
