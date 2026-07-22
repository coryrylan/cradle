// Composes the argv that runs an agent folder: an explicit `pi` invocation
// (system prompt, generated extensions, skills, model settings, session dir),
// optionally wrapped in `nono run` for the `'nono'` backend. The `'sbx'`
// backend's `sbx exec` wrapper is composed later, at materialization in
// `commands/start.ts` — out of scope here, see `LaunchSpec.backend`. Also
// composes the spawn env — see `composeEnv` for cradle's single deliberate
// env-var exception.

import { join } from 'node:path';

import { AGENT_BROWSER_NONO_FALLBACK_EXTENSION_FILE } from './extensions/agent-browser-nono-fallback.js';
import type { AgentFolder, SandboxBackend } from './folder.js';

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
  /**
   * Which sandbox backend wraps this run, or `null` for unsandboxed. `'nono'`
   * wraps the argv here — see `composeArgv`. `'sbx'` does NOT wrap here: its
   * `sbx exec` wrapper is composed at materialization in `commands/start.ts`,
   * so `composeArgv` returns the bare pi argv for both `'sbx'` and `null`.
   * For `'sbx'`, `piBin` is the literal `pi` — resolved on the guest's PATH,
   * since host paths (mise-shim included) are meaningless inside the
   * microVM.
   */
  readonly backend: SandboxBackend | null;
  readonly passthrough: readonly string[];
  /** Resolved path, or bare `nono` for dry-run previews. */
  readonly nonoBin: string;
  /**
   * Resolved path (mise-shim fallback included, see `util/which.ts`), or bare
   * `pi` for dry-run previews. Used consistently whether or not the run is
   * nono-sandboxed — the generated profile already grants read on the mise
   * install tree (see `nono/cradle-pi.json`), so the absolute path resolves
   * inside the sandbox too; a bare `pi` only resolves on whatever PATH the
   * spawning process happens to have, which is exactly the gap a fresh
   * mise-only install falls into. See `backend` for the `'sbx'` exception.
   */
  readonly piBin: string;
  /** Abs path of the generated per-agent nono profile; used only when `backend` is `'nono'`. */
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
 * The system-prompt flags for a folder: `--system-prompt <SYSTEM.md>` (replaces
 * pi's default prompt) and/or `--append-system-prompt <APPEND_SYSTEM.md>`
 * (appends to it). pi reads a flag value as a file when it's an existing path,
 * so cradle passes the paths explicitly (pi can't discover either file in an
 * arbitrary folder). Both ride together when the folder ships both — pi uses
 * SYSTEM.md as the base with APPEND_SYSTEM.md appended — and `loadAgentFolder`
 * guarantees at least one path is non-null, so this is never empty.
 */
function composeSystemPromptArgs(folder: AgentFolder): string[] {
  const args: string[] = [];
  if (folder.systemFilePath !== null) args.push('--system-prompt', folder.systemFilePath);
  if (folder.appendSystemFilePath !== null) args.push('--append-system-prompt', folder.appendSystemFilePath);
  return args;
}

/**
 * Build the bare pi argv. `passthrough` lands last so user-passed flags win
 * under pi's last-wins parsing. The `-e` order is load-bearing: the generated
 * providers extension goes first, followed by the nono-only agent-browser
 * host-socket fallback, the resolved package entries, then the agent's own
 * `extensions/` files — which load with the agent's providers registered,
 * nono subprocess compatibility configured, and any package-provided tools
 * already available, since the agent's own extensions may depend on them.
 */
export function composePiArgv(spec: LaunchSpec): string[] {
  const { folder } = spec;
  const { settings } = folder;
  const argv = [
    spec.piBin,
    ...composeSystemPromptArgs(folder),
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates'
  ];
  if (folder.providersJson !== null) argv.push('-e', join(spec.extensionsDir, 'providers.ts'));
  if (spec.backend === 'nono') argv.push('-e', join(spec.extensionsDir, AGENT_BROWSER_NONO_FALLBACK_EXTENSION_FILE));
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
 * Compose the spawn env for a nono-sandboxed run: `{ MISE_CACHE_DIR: spec.miseCacheDir }`;
 * `{}` for `'sbx'` and unsandboxed runs alike.
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
 * around; the sbx guest has no mise at all, and its HOME override rides the
 * `sbx exec` argv composed in `commands/start.ts` rather than env, so the
 * argv-only rule holds there too.
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
  return spec.backend === 'nono' ? { MISE_CACHE_DIR: spec.miseCacheDir } : {};
}

/**
 * Build the argv for `nono run … -- pi …` when `spec.backend` is `'nono'`, or
 * the bare pi argv otherwise (`'sbx'` or `null`) — the `'sbx'` backend's own
 * `sbx exec` wrapper is composed later, at materialization in
 * `commands/start.ts`, not here (see `LaunchSpec.backend`).
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
  if (spec.backend !== 'nono') return piArgv;
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
