// Composes the argv that runs an agent folder: an explicit `pi` invocation
// (system prompt, generated extensions, skills, model settings, session dir),
// optionally wrapped in `nono run`.

import type { AgentFolder } from './folder.js';
import { statePaths } from './state.js';

export interface EmittedExtensions {
  /** Abs path of the generated providers extension, `null` when the agent has no models.json. */
  readonly providers: string | null;
}

export interface LaunchSpec {
  readonly folder: AgentFolder;
  readonly stateDir: string;
  readonly emitted: EmittedExtensions;
  readonly sandbox: boolean;
  readonly passthrough: readonly string[];
  /** Resolved path, or bare `nono` for dry-run previews. */
  readonly nonoBin: string;
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
  const { folder, emitted } = spec;
  const { settings } = folder;
  const argv = [
    'pi',
    '--append-system-prompt',
    folder.appendSystemFilePath,
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates'
  ];
  if (emitted.providers !== null) argv.push('-e', emitted.providers);
  for (const entry of spec.packageEntries ?? []) argv.push('-e', entry);
  for (const extension of folder.extensionFiles) argv.push('-e', extension);
  if (folder.skillsDir !== null) argv.push('--skill', folder.skillsDir);
  if (settings.defaultProvider !== undefined) argv.push('--provider', settings.defaultProvider);
  if (settings.defaultModel !== undefined) argv.push('--model', settings.defaultModel);
  if (settings.defaultThinkingLevel !== undefined) argv.push('--thinking', settings.defaultThinkingLevel);
  argv.push('--session-dir', statePaths(spec.stateDir).sessionsDir);
  argv.push(...spec.passthrough);
  return argv;
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
 * nono runs by its resolved path (`spec.nonoBin`) because cradle spawns it
 * directly and a freshly mise-installed nono may not be on PATH yet (mise
 * shim). `pi` stays a bare name: nono execs it *inside* the sandbox, where
 * `mise activate` exposes the tool's install dir (inside the
 * `$HOME/.local/share/mise` tree the profile grants) — the mise shim would
 * route through an ungranted path. nono guarantees child processes inherit the
 * sandbox, so pi spawning its own subprocesses is covered too.
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
