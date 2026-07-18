// Composes the argv that runs an agent folder: an explicit `pi` invocation
// (system prompt, generated extensions, skills, model settings, session dir),
// optionally wrapped in `nono run`. Also composes the spawn env — see
// `composeEnv` for cradle's single deliberate env-var exception.

import { join } from 'node:path';

import type { AgentFolder } from './folder.js';

export interface LaunchSpec {
  readonly folder: AgentFolder;
  readonly stateDir: string;
  /**
   * Where the generated providers extension is written (see
   * `folder.providersJson`) and where `--session-dir` points, sourced from the
   * plan's own `extensionsDir`/`sessionsDir` (`commands/start.ts` — the single
   * derivation site; re-deriving from `stateDir` here risks silently
   * disagreeing with a plan whose dirs were overridden after `planStart`).
   */
  readonly extensionsDir: string;
  readonly sessionsDir: string;
  /**
   * Where sandboxed runs point `MISE_CACHE_DIR` (see `composeEnv`), sourced
   * from the plan's `statePaths` derivation like `extensionsDir`/`sessionsDir`.
   */
  readonly miseCacheDir: string;
  readonly sandbox: boolean;
  readonly passthrough: readonly string[];
  /** Resolved path, or bare `nono` for dry-run previews. */
  readonly nonoBin: string;
  /**
   * Resolved path (mise-shim fallback included, see `util/which.ts`), or bare
   * `pi` for dry-run previews. Used consistently whether or not the run is
   * sandboxed — the generated profile already grants read on the mise install
   * tree (see `nono/cradle-pi.json`), so the absolute path resolves inside the
   * sandbox too; a bare `pi` only resolves on whatever PATH the spawning
   * process happens to have, which is exactly the gap a fresh mise-only
   * install falls into.
   */
  readonly piBin: string;
  /** Abs path of the generated per-agent nono profile; used only when `sandbox` is true. */
  readonly profilePath: string;
  /**
   * When true, nono runs without `--silent` so its capabilities banner
   * (effective grants + network disclosure) prints; default is silent — the
   * generated profile file and `--verbose` are the audit surfaces.
   */
  readonly verbose?: boolean;
  /**
   * Abs paths of the pi extension entry files resolved from settings.json's
   * `packages` (see `./packages.js`), installed into `<stateDir>/npm` by
   * `commands/start.ts`. Absent/empty on the argv-only preview used for
   * `--dry-run` (packages resolve at install time, after the preview is
   * printed) and on folders that declare no packages.
   */
  readonly packageEntries?: readonly string[];
}

/**
 * Build the bare pi argv. `passthrough` lands last so user-passed flags win
 * under pi's last-wins parsing. The `-e` order is load-bearing: the generated
 * providers extension goes first, then the resolved package entries, then the
 * agent's own `extensions/` files — which load with the agent's providers
 * registered and any package-provided tools already available, since the
 * agent's own extensions may depend on them.
 */
export function composePiArgv(spec: LaunchSpec): string[] {
  const { folder } = spec;
  const { settings } = folder;
  const argv = [
    spec.piBin,
    '--append-system-prompt',
    folder.appendSystemFilePath,
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates'
  ];
  if (folder.providersJson !== null) argv.push('-e', join(spec.extensionsDir, 'providers.ts'));
  for (const entry of spec.packageEntries ?? []) argv.push('-e', entry);
  for (const extension of folder.extensionFiles) argv.push('-e', extension);
  if (folder.skillsDir !== null) argv.push('--skill', folder.skillsDir);
  if (settings.defaultProvider !== undefined) argv.push('--provider', settings.defaultProvider);
  if (settings.defaultModel !== undefined) argv.push('--model', settings.defaultModel);
  if (settings.defaultThinkingLevel !== undefined) argv.push('--thinking', settings.defaultThinkingLevel);
  argv.push('--session-dir', spec.sessionsDir);
  argv.push(...spec.passthrough);
  return argv;
}

/**
 * Compose the spawn env for a sandboxed run: `{ MISE_CACHE_DIR: spec.miseCacheDir }`;
 * `{}` when unsandboxed.
 *
 * The generated profile denies the shared `~/Library/Caches/mise` on purpose
 * — a poisoned `bin_paths` cache would redirect which binaries the user's
 * later UNSANDBOXED mise execs resolve to, invisibly and machine-globally.
 * Without this override, every sandboxed `mise exec` spams `mise WARN failed
 * to write cache file` because it can't write there. Pointing `MISE_CACHE_DIR`
 * at a private cache inside the already-granted state dir instead lets mise
 * cache writes succeed (no warnings, working cache) while the shared host
 * cache stays untouched; mise creates the directory itself, cradle never
 * pre-creates or wipes it. Unsandboxed runs return `{}` and keep the shared
 * host cache — no override needed since there's no sandbox denial to work
 * around.
 *
 * This deliberately overrides any user-set `MISE_CACHE_DIR` for sandboxed
 * runs — the profile wouldn't grant a custom location either, so honoring one
 * would just trade the warning spam for a silent cache-write failure. It is
 * also cradle's single exception to argv-only composition (see the module
 * header and `ARCHITECTURE.md`'s "Why argv" section): this configures mise,
 * not pi, so it doesn't touch the argv-survives-sandboxing rationale that
 * motivates keeping pi's own configuration on argv. The failure mode if this
 * env var were ever stripped is benign — mise falls back to the shared cache
 * and the warnings return, nothing breaks.
 */
export function composeEnv(spec: LaunchSpec): Record<string, string> {
  return spec.sandbox ? { MISE_CACHE_DIR: spec.miseCacheDir } : {};
}

/**
 * Build the argv for `nono run … -- pi …`, or the bare pi argv when
 * sandboxing is disabled (`--no-sandbox`).
 *
 * All filesystem grants (cwd, agent dir, state dir, and the agent's own
 * `sandbox/nono.json` entries) AND the network posture live inside the
 * generated per-agent profile at `spec.profilePath` — see `nono/profiles.ts`.
 * The wrapper is `nono run --silent --profile <file>` by default (silent mode
 * suppresses nono's startup banner); `--verbose` omits `--silent` to show the
 * capabilities banner, and cradle prints `🔒 Sandbox Active` on silent runs.
 * No per-flag network posture — it all lives in the profile.
 *
 * Both `spec.nonoBin` and `spec.piBin` are resolved paths (mise-shim fallback
 * included), never bare names: cradle spawns `nonoBin` directly, and a
 * freshly mise-installed nono may not be on PATH yet; `piBin` is passed
 * through to nono as plain argv (`-- <piBin> …`), and nono execs it *inside*
 * the sandbox, where the resolved absolute path resolves fine against the
 * mise install tree the base profile already grants read on (see
 * `nono/cradle-pi.json`) — no PATH lookup needed either side of the sandbox
 * boundary. nono guarantees child processes inherit the sandbox, so pi
 * spawning its own subprocesses is covered too.
 */
export function composeArgv(spec: LaunchSpec): string[] {
  const piArgv = composePiArgv(spec);
  if (!spec.sandbox) return piArgv;
  return [
    spec.nonoBin,
    'run',
    ...(spec.verbose === true ? [] : ['--silent']),
    '--profile',
    spec.profilePath,
    '--',
    ...piArgv
  ];
}
