// `cradle start <dir>`: load an agent folder, generate its pi extensions into
// the per-agent state dir, and compose the (optionally nono-wrapped) pi argv.
// Split into a pure-ish `planStart` and a fs-touching `materializeStart` so the CLI
// can print the plan on --dry-run and tests can assert both halves in-process.

import { exists, mkdir, rm, writeFile } from 'node:fs/promises';
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
import { stateDirFor, statePaths } from '../agent/state.js';
import { resolveLinkedGitDir } from '../nono/linked-git-dir.js';
import { AGENT_PROFILE_FILE, buildProfileJson, findDegenerateSandboxCwd } from '../nono/profiles.js';
import { installTree, readTextIfExists, type InstallContext, type TreeFile } from '../setup/install.js';
import { requireBin, type WhichFn } from '../util/which.js';

export interface StartFlags {
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
}

interface StartDeps {
  readonly cwd?: string;
  readonly home?: string;
  readonly which?: WhichFn;
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

export interface StartPlan {
  /** Generated extensions, relative to `extensionsDir`. */
  readonly files: readonly TreeFile[];
  /**
   * Authoritative — the single derivation site for where generated extensions
   * and sessions live. `materializeStart` re-asserts these onto `launch`
   * before composing the final argv, so overriding either here (as tests do)
   * changes the composed argv accordingly instead of silently disagreeing
   * with whatever `launch` had baked in at `planStart` time.
   */
  readonly extensionsDir: string;
  readonly sessionsDir: string;
  readonly warnings: readonly string[];
  /** The generated per-agent nono profile to write before spawning; `null` on unsandboxed runs (no profile needed). */
  readonly profile: { readonly path: string; readonly content: string } | null;
  /** Settings.json `packages` resolved into an install plan; `null` when the folder declares none. */
  readonly packages: PackagesPlan | null;
  /** The single argv source: `composeArgv(plan.launch)` — package-entry-free until `materializeStart` recomposes it with resolved package entries. */
  readonly launch: LaunchSpec;
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
export async function planStart(flags: StartFlags, deps: StartDeps = {}): Promise<StartPlan> {
  const home = deps.home ?? homedir();
  const cwd = deps.cwd ?? process.cwd();
  const { dir, warnings: refWarnings } = await resolveAgentRef(flags.dir, { home, cwd });
  const folder = await loadAgentFolder(dir);
  const stateDir = stateDirFor(folder.dir, home);
  const { extensionsDir, sessionsDir, miseCacheDir } = statePaths(stateDir);
  const { sandbox, network, warnings: postureWarnings } = resolvePosture(flags, folder);
  const warnings = [...refWarnings, ...postureWarnings];
  const dryRun = flags.dryRun ?? false;

  const launch = buildLaunch({
    folder,
    flags,
    sandbox,
    dryRun,
    stateDir,
    extensionsDir,
    sessionsDir,
    miseCacheDir,
    ...(deps.which !== undefined ? { which: deps.which } : {})
  });
  const files = emitExtensionFiles(folder, sandbox);
  const linkedGitDir = sandbox ? await resolveLinkedGitDir(cwd) : undefined;
  const profile = sandboxPlan(sandbox, folder, network, {
    home,
    cwd,
    stateDir,
    profilePath: launch.profilePath,
    ...(linkedGitDir !== undefined ? { linkedGitDir } : {})
  });
  const packages = buildPackagesPlan(folder, stateDir);
  return { files, extensionsDir, sessionsDir, warnings, profile, packages, launch, dryRun };
}

interface LaunchContext {
  readonly folder: AgentFolder;
  readonly flags: StartFlags;
  readonly sandbox: boolean;
  readonly dryRun: boolean;
  readonly stateDir: string;
  readonly extensionsDir: string;
  readonly sessionsDir: string;
  readonly miseCacheDir: string;
  readonly which?: WhichFn;
}

/** Resolve the bins, generated-extension paths, and profile path into the `LaunchSpec` `composeArgv` consumes. */
function buildLaunch(ctx: LaunchContext): LaunchSpec {
  const { folder, flags, sandbox, dryRun, stateDir, extensionsDir, sessionsDir, miseCacheDir, which } = ctx;
  const { nonoBin, piBin } = resolveBins(sandbox, dryRun, which);
  const profilePath = join(stateDir, AGENT_PROFILE_FILE);
  return {
    folder,
    stateDir,
    extensionsDir,
    sessionsDir,
    miseCacheDir,
    sandbox,
    passthrough: flags.passthrough ?? [],
    nonoBin,
    piBin,
    profilePath,
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

/** Resolve the sandbox on/off decision and the network posture together, with their combined warnings. */
function resolvePosture(
  flags: StartFlags,
  folder: AgentFolder
): { sandbox: boolean; network: AgentNetwork | undefined; warnings: readonly string[] } {
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
 * Precedence: `--offline` > `--allow-host` > the folder's `sandbox/nono.json`
 * `network` > open default. CLI flags REPLACE the folder network (no merge) so
 * the effective posture is always unambiguous.
 */
function resolveNetwork(flags: StartFlags, folder: AgentFolder, warnings: string[]): AgentNetwork | undefined {
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
function hasRestrictiveNetworkFlags(flags: StartFlags): boolean {
  return flags.offline === true || (flags.allowHost?.length ?? 0) > 0;
}

/** Resolve sandboxing: explicit CLI choice > sandbox/nono.json > restrictive network flags force it on > unsandboxed default. */
function resolveSandbox(flags: StartFlags, folder: AgentFolder): { sandbox: boolean; warnings: readonly string[] } {
  const cli = flags.noSandbox === undefined ? undefined : !flags.noSandbox;
  if (cli !== undefined) return { sandbox: cli, warnings: folder.warnings };
  if (folder.sandbox.posture === 'enabled') return { sandbox: true, warnings: folder.warnings };
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
 * dir, and — on sandboxed runs — (re)write the generated per-agent nono profile
 * that `nono run --profile` points at. When the folder declares `packages`,
 * also (re)install the per-agent npm project and resolve each package's pi
 * extension entries, returning the final argv with those entries appended as
 * `-e` flags plus any resolution warnings; otherwise the plan's argv is
 * already final.
 */
export async function materializeStart(
  plan: StartPlan,
  deps: MaterializeDeps = {}
): Promise<{ argv: string[]; warnings: string[] }> {
  // Sequential on purpose: installTree collects failures into ctx, and its
  // friendly one-line error must surface before any raw fs error the later
  // writes would throw when the same state dir is unwritable.
  const ctx: InstallContext = { dryRun: false, results: [], failures: [] };
  await installTree(ctx, 'extensions', plan.extensionsDir, plan.files);
  if (ctx.failures.length > 0) {
    throw new Error(`failed to write agent extensions: ${ctx.failures.join('; ')}`);
  }
  await mkdir(plan.sessionsDir, { recursive: true });
  if (plan.profile !== null) {
    await mkdir(dirname(plan.profile.path), { recursive: true });
    await writeFile(plan.profile.path, plan.profile.content, 'utf8');
  }
  // `plan.extensionsDir`/`plan.sessionsDir` are authoritative (see `StartPlan`
  // docs): re-assert them onto `launch` here so a plan whose dirs were
  // overridden after `planStart` still gets a composed argv that agrees with
  // what was actually written to disk above, instead of whatever `launch` had
  // baked in at `planStart` time.
  const launch: LaunchSpec = { ...plan.launch, extensionsDir: plan.extensionsDir, sessionsDir: plan.sessionsDir };
  if (plan.packages === null) return { argv: composeArgv(launch), warnings: [] };
  return installAndResolvePackages(plan.packages, launch, deps);
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
      throw new Error('packages declared but no installer provided');
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

/**
 * Verify the required bins and resolve their spawn paths. `pi`'s resolved path
 * (mise-shim fallback included, see `util/which.ts`) is threaded through to
 * `composePiArgv` unchanged so a doctor-clean, PATH-miss-but-shim-present `pi`
 * still spawns — a bare `'pi'` string only resolves via the spawning
 * process's own PATH, which is exactly the gap the shim fallback exists to
 * cover. `--dry-run` only previews, so it deliberately skips the checks — you
 * can compose a command before pi/nono are installed.
 */
function resolveBins(sandbox: boolean, dryRun: boolean, which?: WhichFn): ResolvedBins {
  if (dryRun) return { nonoBin: 'nono', piBin: 'pi' };
  const nonoBin = sandbox ? requireBin('nono', which) : 'nono';
  const piBin = requireBin('pi', which);
  return { nonoBin, piBin };
}

/**
 * Sandbox-only artifact of the plan: the generated per-agent nono profile
 * (path + content; grants, network, and seatbelt rules baked in). Runs are
 * silent by default (`--silent` is passed to nono); `--verbose` shows nono's
 * capabilities banner (grants + network mode), and the generated profile file
 * is the complete audit surface (seatbelt rules never appear in the banner
 * even with `--verbose`). Returns `null` on unsandboxed runs, which need no
 * profile.
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
  ctx: { home: string; cwd: string; stateDir: string; profilePath: string; linkedGitDir?: string }
): { path: string; content: string } | null {
  if (!sandbox) return null;
  const degenerateCwd = findDegenerateSandboxCwd(ctx.cwd, ctx.home);
  if (degenerateCwd !== undefined) {
    throw new Error(
      `cannot sandbox from ${degenerateCwd} — this directory is (or contains) nono's protected state root ` +
        `(~/.local/state/nono) and nono refuses to start with an overlapping grant; run \`cradle start\` from a ` +
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
    ...(network !== undefined ? { network } : {}),
    ...(ctx.linkedGitDir !== undefined ? { linkedGitDir: ctx.linkedGitDir } : {})
  });
  return { path: ctx.profilePath, content };
}

function emitExtensionFiles(folder: AgentFolder, sandbox: boolean): TreeFile[] {
  return [
    ...(folder.providersJson !== null
      ? [{ rel: 'providers.ts', content: emitProvidersExtension(folder.providersJson) }]
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
