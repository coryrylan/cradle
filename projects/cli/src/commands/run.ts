// Load an agent folder, plan its pi launch and optional nono profile, then
// materialize generated files and packages before spawning.

import { exists, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { resolveAgentRef } from '../agent/aliases.js';
import {
  AGENT_BROWSER_NONO_FALLBACK_EXTENSION_FILE,
  emitAgentBrowserNonoFallbackExtension
} from '../agent/extensions/agent-browser-nono-fallback.js';
import { emitProvidersExtension } from '../agent/extensions/providers.js';
import { loadAgentFolder, type AgentFolder, type AgentNetwork } from '../agent/folder.js';
import { composeArgv, type LaunchSpec } from '../agent/launch.js';
import { emitPackagesManifest, resolvePackageEntries, type NpmPackageSpec } from '../agent/packages.js';
import { loadSchedules, missingScheduleDirError, type Schedule } from '../agent/schedules.js';
import { stateDirFor, statePaths } from '../agent/state.js';
import { getTerminalIntegrations, type TerminalIntegrations } from '../agent/terminal-integrations.js';
import { resolveLinkedGitDir } from '../nono/linked-git-dir.js';
import { AGENT_PROFILE_FILE, buildProfileJson, findDegenerateSandboxCwd } from '../nono/profiles.js';
import { installTree, readTextIfExists, type InstallContext, type TreeFile } from '../setup/install.js';
import { requireBin, type WhichFn } from '../util/which.js';

export interface RunFlags {
  readonly dir: string;
  /** `--offline` → full network block. Overrides the folder network posture and forces the sandbox on (unless --no-sandbox). */
  readonly offline?: boolean;
  /** `--allow-host` (repeatable) → network host allowlist. Overrides the folder allowlist and forces the sandbox on (unless --no-sandbox). */
  readonly allowHost?: readonly string[];
  /** Explicit CLI choice: `--no-sandbox` → true, `--sandbox` → false. Absent = defer to the folder. */
  readonly noSandbox?: boolean;
  readonly dryRun?: boolean;
  readonly passthrough?: readonly string[];
  /** `--verbose` → show nono's full sandbox capabilities banner instead of the one-line status. */
  readonly verbose?: boolean;
  /**
   * A `schedule/<task>.md` slug to run headless instead of starting an
   * interactive session. The named schedule's `cwd` replaces the run's
   * effective working directory (see `RunPlan.cwd`), and its body is appended
   * to the launch passthrough as `--print --name <name> --no-approve --
   * <prompt>`, after any user `--` passthrough so it always terminates the
   * argv. Set only by `cradle schedule run` — and therefore by the OS timers,
   * whose composed argv is exactly that command (see `schedule/launchd.ts`
   * and `schedule/systemd.ts`). There is deliberately no `--schedule` flag on
   * `cradle run`: two spellings of one action is one too many.
   */
  readonly schedule?: string;
}

interface RunDeps {
  readonly cwd?: string;
  readonly home?: string;
  readonly which?: WhichFn;
  /** Host terminal discovery environment; defaults to the inherited process environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

/**
 * The agent's settings.json `packages` resolved into a per-agent npm install
 * plan. `npmDir` is a private npm project under the agent's state dir — never
 * the folder itself, so the install stays out of the portable, committable
 * agent folder.
 */
export interface PackagesPlan {
  readonly npmDir: string;
  /** `emitPackagesManifest` output — the package.json cradle writes into `npmDir`. */
  readonly manifest: string;
  readonly specs: readonly NpmPackageSpec[];
  /**
   * `[...(settings.npmCommand ?? ['npm']), 'install', '--ignore-scripts']`.
   * This install runs on the host, unsandboxed, before the sandbox spawns —
   * `--ignore-scripts` stops a folder-declared package's postinstall from
   * running arbitrary host code (`npmCommand` is validated upstream to a
   * single-element allowlist of `npm`/`pnpm`/`yarn`/`bun`, all of which accept
   * this flag).
   */
  readonly installCommand: readonly string[];
}

export interface RunPlan {
  /** Generated extensions, relative to `extensionsDir`. */
  readonly files: readonly TreeFile[];
  /**
   * Authoritative — the single derivation site for where generated extensions
   * and sessions live. `materializeRun` re-asserts these onto `launch`
   * before composing the final argv, so overriding either here (as tests do)
   * changes the composed argv accordingly instead of silently disagreeing
   * with whatever `launch` had baked in at `planRun` time.
   */
  readonly extensionsDir: string;
  readonly sessionsDir: string;
  readonly warnings: readonly string[];
  /** The generated per-agent nono profile to write before spawning; `null` when sandboxing is disabled. */
  readonly profile: { readonly path: string; readonly content: string } | null;
  /** Settings.json `packages` resolved into an install plan; `null` when the folder declares none. */
  readonly packages: PackagesPlan | null;
  /** The single argv source: `composeArgv(plan.launch)` — package-entry-free until `materializeRun` recomposes it with resolved package entries. */
  readonly launch: LaunchSpec;
  /**
   * The effective working directory: the terminal cwd, a named alias's cwd,
   * or `flags.schedule`'s `Schedule.cwd` (highest precedence). Callers spawn here — `cli.ts`
   * passes it to `runForeground` — since a scheduled run's launchd/systemd
   * invocation carries no shell `cd` of its own.
   */
  readonly cwd: string;
  readonly dryRun: boolean;
}

/**
 * Resolve the ref (bare alias name or path — see `../agent/aliases.js`), load
 * the agent folder, and compose the launch. Returns a plan; the caller
 * decides whether to print it (`--dry-run`) or materialize + spawn it.
 *
 * `--dry-run` only previews, so it deliberately skips the bin checks — you can
 * compose a command before nono/pi are installed.
 */
export async function planRun(flags: RunFlags, deps: RunDeps = {}): Promise<RunPlan> {
  const home = deps.home ?? homedir();
  const baseCwd = deps.cwd ?? process.cwd();
  const { dir, cwd: aliasCwd, warnings: refWarnings } = await resolveAgentRef(flags.dir, { home, cwd: baseCwd });
  const folder = await loadAgentFolder(dir);
  const scheduled = await resolveScheduledRun(flags, folder, home, aliasCwd ?? baseCwd);
  if (aliasCwd !== undefined && flags.schedule === undefined) await assertAliasCwd(aliasCwd, flags.dir);
  const stateDir = stateDirFor(folder.dir, home);
  const { extensionsDir, sessionsDir, miseCacheDir } = statePaths(stateDir);
  const posture = resolvePosture(flags, folder);
  const dryRun = flags.dryRun ?? false;
  const bins = resolveBins(posture.sandbox, dryRun, deps.which);
  const launch = await buildLaunch({
    home,
    deps,
    folder,
    flags,
    passthrough: scheduled.passthrough,
    sandbox: posture.sandbox,
    bins,
    stateDir,
    extensionsDir,
    sessionsDir,
    miseCacheDir
  });
  const isolation = await buildIsolation(posture, folder, {
    home,
    cwd: scheduled.cwd,
    stateDir,
    profilePath: launch.profilePath,
    terminalIntegrations: launch.terminalIntegrations
  });
  const packages = buildPackagesPlan(folder, stateDir);
  return {
    files: emitExtensionFiles(folder, posture.sandbox),
    extensionsDir,
    sessionsDir,
    warnings: [...refWarnings, ...scheduled.warnings, ...posture.warnings],
    profile: isolation,
    packages,
    launch,
    cwd: scheduled.cwd,
    dryRun
  };
}

async function assertAliasCwd(cwd: string, name: string): Promise<void> {
  if ((await exists(cwd)) && (await stat(cwd)).isDirectory()) return;
  throw new Error(`Alias "${name}" cwd is not a directory: ${cwd}`);
}

interface ScheduledRunPlan {
  /** `Schedule.cwd` when `--schedule` resolved one, the alias cwd or terminal cwd otherwise. */
  readonly cwd: string;
  /** `flags.passthrough` as-is, or with the schedule's headless invocation appended. */
  readonly passthrough: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Resolve `flags.schedule` (`--schedule <task>`) against the folder's
 * `schedule/` dir, folding the result onto `baseCwd`/`flags.passthrough` so
 * `planRun` never branches on whether a schedule was requested. Requires
 * `folder.scheduleDir` and a matching slug — both hard errors, since a
 * scheduled run that silently falls back to an interactive session would
 * hang a headless invocation forever.
 */
async function resolveScheduledRun(
  flags: RunFlags,
  folder: AgentFolder,
  home: string,
  baseCwd: string
): Promise<ScheduledRunPlan> {
  const unscheduled: ScheduledRunPlan = { cwd: baseCwd, passthrough: flags.passthrough ?? [], warnings: [] };
  if (flags.schedule === undefined) return unscheduled;
  if (folder.scheduleDir === null) {
    throw await missingScheduleDirError(folder.dir);
  }
  const { schedules, warnings } = await loadSchedules(folder.scheduleDir, home);
  const schedule = schedules.find(candidate => candidate.slug === flags.schedule);
  if (schedule === undefined) {
    throw new Error(unknownScheduleMessage(flags.schedule, schedules));
  }
  return {
    cwd: schedule.cwd,
    passthrough: [
      ...unscheduled.passthrough,
      '--print',
      '--name',
      schedule.name,
      '--no-approve',
      '--',
      schedule.prompt
    ],
    warnings: [...warnings, ...(await missingScheduleCwdWarning(schedule))]
  };
}

/** A schedule's cwd is read lazily on every run — worth catching now, not at 9am when the timer fires into a missing directory. */
async function missingScheduleCwdWarning(schedule: Schedule): Promise<readonly string[]> {
  if (await exists(schedule.cwd)) return [];
  return [`schedule "${schedule.slug}" cwd does not exist: ${schedule.cwd}`];
}

/** Mirrors `aliases.ts`'s `bothMissedMessage` style — names the requested slug and lists what's available. */
function unknownScheduleMessage(slug: string, schedules: readonly Schedule[]): string {
  const known =
    schedules.length > 0
      ? ` (available: ${schedules.map(schedule => schedule.slug).join(', ')})`
      : ' (schedule/ is empty)';
  return `Unknown schedule "${slug}"${known}`;
}

interface LaunchContext {
  readonly home: string;
  readonly deps: RunDeps;
  readonly folder: AgentFolder;
  readonly flags: RunFlags;
  /** The resolved passthrough — `flags.passthrough` plain, or with a `--schedule` invocation appended (see `resolveScheduledRun`). */
  readonly passthrough: readonly string[];
  readonly sandbox: boolean;
  readonly bins: ResolvedBins;
  readonly stateDir: string;
  readonly extensionsDir: string;
  readonly sessionsDir: string;
  readonly miseCacheDir: string;
}

interface PlannedLaunch extends LaunchSpec {
  readonly terminalIntegrations: TerminalIntegrations;
}

/** Resolve the generated-extension paths and profile path into the `LaunchSpec` `composeArgv` consumes. */
async function buildLaunch(ctx: LaunchContext): Promise<PlannedLaunch> {
  const { folder, flags, passthrough, sandbox, bins, stateDir, extensionsDir, sessionsDir, miseCacheDir } = ctx;
  return {
    terminalIntegrations: await getTerminalIntegrations({
      home: ctx.home,
      env: ctx.deps.env ?? process.env,
      platform: ctx.deps.platform ?? process.platform,
      enabled: flags.schedule === undefined
    }),
    folder,
    stateDir,
    extensionsDir,
    sessionsDir,
    miseCacheDir,
    sandbox,
    passthrough,
    nonoBin: bins.nonoBin,
    piBin: bins.piBin,
    profilePath: join(stateDir, AGENT_PROFILE_FILE),
    ...(flags.verbose ? { verbose: true } : {})
  };
}

/** Resolve settings.json's `packages` (see `../agent/packages.js`) into a per-agent npm install plan; `null` when none. */
function buildPackagesPlan(folder: AgentFolder, stateDir: string): PackagesPlan | null {
  const specs = folder.settings.packages;
  if (specs === undefined || specs.length === 0) return null;
  return {
    npmDir: join(stateDir, 'npm'),
    manifest: emitPackagesManifest(specs),
    specs,
    installCommand: [...(folder.settings.npmCommand ?? ['npm']), 'install', '--ignore-scripts']
  };
}

interface ResolvedPosture {
  readonly sandbox: boolean;
  readonly network: AgentNetwork | undefined;
  readonly warnings: readonly string[];
}

/** Resolve sandbox enablement and the network posture together, with their combined warnings. */
function resolvePosture(flags: RunFlags, folder: AgentFolder): ResolvedPosture {
  const { sandbox, warnings } = resolveSandbox(flags, folder);
  const networkWarnings: string[] = [];
  const network = resolveNetwork(flags, folder, networkWarnings);
  return {
    sandbox,
    network,
    warnings: withUnsandboxedNetworkWarning(sandbox, network, [...warnings, ...networkWarnings])
  };
}

/**
 * Precedence: `--offline` > `--allow-host` > sandbox/nono.json network > open default. CLI flags REPLACE the folder network
 * (no merge) so the effective posture is always unambiguous.
 */
function resolveNetwork(flags: RunFlags, folder: AgentFolder, warnings: string[]): AgentNetwork | undefined {
  if (flags.offline) return { block: true };
  const allowHost = readCliHostList(flags.allowHost ?? [], warnings);
  if (allowHost.length > 0) return { allowDomain: allowHost };
  return folder.sandbox.network;
}

/**
 * Trim `--allow-host` entries and drop blanks — mirrors `folder.ts`'s
 * `readHostList` (the folder-side `network.allow_domain` reader): an
 * untrimmed host lands verbatim in the profile's `allow_domain` and never
 * matches at proxy time.
 */
function readCliHostList(hosts: readonly string[], warnings: string[]): readonly string[] {
  const trimmed = hosts.map(host => host.trim()).filter(host => host !== '');
  if (trimmed.length !== hosts.length) warnings.push('--allow-host entries must be non-empty — blanks ignored');
  return trimmed;
}

/** A restrictive posture (block/allowlist) needs the sandbox to mean anything; open/port-only doesn't. */
function isRestrictiveNetwork(network: AgentNetwork | undefined): boolean {
  return network !== undefined && (network.block === true || (network.allowDomain?.length ?? 0) > 0);
}

/** An unsandboxed run enforces no network policy — a restrictive posture (block/allowlist) warns loudly regardless of why the sandbox is off. */
function withUnsandboxedNetworkWarning(
  sandbox: boolean,
  network: AgentNetwork | undefined,
  base: readonly string[]
): readonly string[] {
  if (sandbox || !isRestrictiveNetwork(network)) return base;
  return [
    ...base,
    'network policy has no effect without the sandbox — pi runs with no network isolation (--sandbox to enforce it)'
  ];
}

/** `--offline`/`--allow-host` request a network posture restrictive enough to force the sandbox on. */
function hasRestrictiveNetworkFlags(flags: RunFlags): boolean {
  return flags.offline === true || (flags.allowHost?.length ?? 0) > 0;
}

/** CLI sandbox overrides take precedence over the folder posture. */
function resolveSandbox(flags: RunFlags, folder: AgentFolder): Pick<ResolvedPosture, 'sandbox' | 'warnings'> {
  if (flags.noSandbox === true) return { sandbox: false, warnings: folder.warnings };
  if (flags.noSandbox === false || folder.sandbox.posture === 'enabled') {
    return { sandbox: true, warnings: folder.warnings };
  }
  const reason =
    folder.sandbox.posture === 'disabled' ? 'sandbox disabled by sandbox/nono.json' : 'sandbox/nono.json not found';
  if (hasRestrictiveNetworkFlags(flags)) {
    return {
      sandbox: true,
      warnings: [
        ...folder.warnings,
        `${reason} — sandbox forced on to enforce the requested network policy (--no-sandbox to override)`
      ]
    };
  }
  return {
    sandbox: false,
    warnings: [...folder.warnings, `${reason} — agent is running without OS isolation (--sandbox to force enable)`]
  };
}

export interface MaterializeDeps {
  /** Runs a package install (e.g. `npm install`) in `cwd`; `cli.ts` always passes `runInstall` from `util/proc.js`. */
  readonly install?: (command: readonly string[], cwd: string) => Promise<void>;
}

/**
 * Write the generated extensions (replacing stale ones), ensure the sessions
 * dir, and (re)write the generated per-agent nono profile when sandboxed. When the
 * folder declares `packages`, also (re)install the per-agent npm project and
 * resolve each package's pi extension entries, returning the final argv with
 * those entries appended as `-e` flags plus any resolution warnings;
 * otherwise the plan's argv is already final.
 */
export async function materializeRun(
  plan: RunPlan,
  deps: MaterializeDeps = {}
): Promise<{ argv: string[]; warnings: string[] }> {
  // Sequential on purpose: installTree collects failures into ctx, and its
  // friendly one-line error must surface before any raw fs error the later
  // writes would throw when the same state dir is unwritable.
  const ctx: InstallContext = { dryRun: false, results: [], failures: [] };
  await installTree(ctx, 'extensions', plan.extensionsDir, plan.files);
  if (ctx.failures.length > 0) {
    throw new Error(`Failed to write agent extensions: ${ctx.failures.join('; ')}`);
  }
  await mkdir(plan.sessionsDir, { recursive: true });
  if (plan.profile !== null) {
    await mkdir(dirname(plan.profile.path), { recursive: true });
    await writeFile(plan.profile.path, plan.profile.content, 'utf8');
  }
  // `plan.extensionsDir`/`plan.sessionsDir` are authoritative (see `RunPlan`
  // docs): re-assert them onto `launch` here so a plan whose dirs were
  // overridden after `planRun` still gets a composed argv that agrees with
  // what was actually written to disk above, instead of whatever `launch` had
  // baked in at `planRun` time.
  const launch: LaunchSpec = { ...plan.launch, extensionsDir: plan.extensionsDir, sessionsDir: plan.sessionsDir };
  return plan.packages === null
    ? { argv: composeArgv(launch), warnings: [] }
    : await installAndResolvePackages(plan.packages, launch, deps);
}

/** Skip a reinstall when the manifest is unchanged and `node_modules` already exists — npm install is not free. */
async function packagesUpToDate(npmDir: string, manifest: string): Promise<boolean> {
  const existingManifest = await readTextIfExists(join(npmDir, 'package.json'));
  if (existingManifest !== manifest) return false;
  return exists(join(npmDir, 'node_modules'));
}

async function installAndResolvePackages(
  packages: PackagesPlan,
  launch: LaunchSpec,
  deps: MaterializeDeps
): Promise<{ argv: string[]; warnings: string[] }> {
  await mkdir(packages.npmDir, { recursive: true });
  if (!(await packagesUpToDate(packages.npmDir, packages.manifest))) {
    if (deps.install === undefined) {
      throw new Error('Packages declared but no installer provided');
    }
    const manifestPath = join(packages.npmDir, 'package.json');
    await writeFile(manifestPath, packages.manifest, 'utf8');
    try {
      await deps.install(packages.installCommand, packages.npmDir);
    } catch (error) {
      // A failed install must not leave the new manifest behind: with stale
      // node_modules present, packagesUpToDate would skip the reinstall forever.
      await rm(manifestPath, { force: true });
      throw error;
    }
  }
  const { entries, warnings } = await resolvePackageEntries(packages.npmDir, packages.specs);
  return { argv: composeArgv({ ...launch, packageEntries: entries }), warnings };
}

interface ResolvedBins {
  readonly nonoBin: string;
  readonly piBin: string;
}

/** Resolve pi and, when sandboxed, nono; dry-run needs no installed binaries. */
function resolveBins(sandbox: boolean, dryRun: boolean, which?: WhichFn): ResolvedBins {
  if (dryRun) return { nonoBin: 'nono', piBin: 'pi' };
  return {
    nonoBin: sandbox ? requireBin('nono', which) : 'nono',
    piBin: requireBin('pi', which)
  };
}

interface IsolationContext {
  readonly home: string;
  readonly cwd: string;
  readonly stateDir: string;
  readonly profilePath: string;
  readonly terminalIntegrations: TerminalIntegrations;
}

async function buildIsolation(
  posture: ResolvedPosture,
  folder: AgentFolder,
  ctx: IsolationContext
): Promise<RunPlan['profile']> {
  const linkedGitDir = posture.sandbox ? await resolveLinkedGitDir(ctx.cwd) : undefined;
  return sandboxPlan(posture.sandbox, folder, posture.network, {
    ...ctx,
    ...(linkedGitDir !== undefined ? { linkedGitDir } : {})
  });
}

/**
 * Nono-only artifact of the plan: the generated per-agent nono profile
 * (path + content; grants, network, and seatbelt rules baked in). Runs are
 * silent by default (`--silent` is passed to nono); `--verbose` shows nono's
 * capabilities banner (grants + network mode), and the generated profile file
 * is the complete audit surface (seatbelt rules never appear in the banner
 * even with `--verbose`). Returns `null` when sandboxing is disabled.
 *
 * Fails fast on a degenerate cwd (see `findDegenerateSandboxCwd`) before
 * baking it in as the profile's cwd `allow` grant: nono itself refuses to
 * start when a grant overlaps its protected state root, and that refusal is
 * opaque — a cradle-level error here names the offending directory instead.
 */
function sandboxPlan(
  sandbox: boolean,
  folder: AgentFolder,
  network: AgentNetwork | undefined,
  ctx: {
    home: string;
    cwd: string;
    stateDir: string;
    profilePath: string;
    linkedGitDir?: string;
    terminalIntegrations: TerminalIntegrations;
  }
): { path: string; content: string } | null {
  if (!sandbox) return null;
  const degenerateCwd = findDegenerateSandboxCwd(ctx.cwd, ctx.home);
  if (degenerateCwd !== undefined) {
    throw new Error(
      `cannot sandbox from ${degenerateCwd} — this directory is (or contains) nono's protected state root ` +
        `(~/.local/state/nono) and nono refuses to start with an overlapping grant; run \`cradle run\` from a ` +
        `project directory instead`
    );
  }
  const content = buildProfileJson({
    home: ctx.home,
    cwd: ctx.cwd,
    agentDir: folder.dir,
    stateDir: ctx.stateDir,
    grants: folder.sandbox.filesystem,
    rules: folder.sandbox.unsafeMacosSeatbeltRules,
    terminalSocketPaths: ctx.terminalIntegrations.socketPaths,
    terminalExtensionFiles: ctx.terminalIntegrations.extensionFiles,
    ...(network !== undefined ? { network } : {}),
    ...(ctx.linkedGitDir !== undefined ? { linkedGitDir: ctx.linkedGitDir } : {})
  });
  return { path: ctx.profilePath, content };
}

function emitExtensionFiles(folder: AgentFolder, sandbox: boolean): TreeFile[] {
  return [
    ...(folder.providersJson !== null
      ? [
          {
            rel: 'providers.ts',
            content: emitProvidersExtension(folder.providersJson)
          }
        ]
      : []),
    ...(sandbox
      ? [
          {
            rel: AGENT_BROWSER_NONO_FALLBACK_EXTENSION_FILE,
            content: emitAgentBrowserNonoFallbackExtension()
          }
        ]
      : [])
  ];
}
