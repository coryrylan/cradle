// `cradle run <dir>`: load an agent folder, generate its pi extensions into
// the per-agent state dir, and compose the launch — pi wrapped in `nono run`
// for the nono backend, or run through `sbx exec` (after create/policy/
// provision setup) for the sbx backend. Split into a pure-ish `planRun` and
// a fs-touching `materializeRun` so the CLI can print the plan on --dry-run
// and tests can assert both halves in-process.

import { exists, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { resolveAgentRef } from '../agent/aliases.js';
import {
  AGENT_BROWSER_NONO_FALLBACK_EXTENSION_FILE,
  emitAgentBrowserNonoFallbackExtension
} from '../agent/extensions/agent-browser-nono-fallback.js';
import { emitProvidersExtension } from '../agent/extensions/providers.js';
import { loadAgentFolder, type AgentFolder, type AgentNetwork, type SandboxBackend } from '../agent/folder.js';
import { composeArgv, type LaunchSpec } from '../agent/launch.js';
import { emitPackagesManifest, resolvePackageEntries, type NpmPackageSpec } from '../agent/packages.js';
import { stateDirFor, statePaths } from '../agent/state.js';
import { resolveLinkedGitDir } from '../nono/linked-git-dir.js';
import { AGENT_PROFILE_FILE, buildProfileJson, findDegenerateSandboxCwd } from '../nono/profiles.js';
import {
  composeSbxCreateArgv,
  composeSbxExecArgv,
  composeSbxMounts,
  composeSbxPolicyArgvs,
  composeSbxProvisionArgv,
  isSbxAlreadyExistsError,
  sbxGrantWarnings,
  sbxNetworkWarnings,
  sbxSandboxName,
  type SbxSpec
} from '../sbx/compose.js';
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
  /** `--sandbox-backend` → explicit backend choice; implies the sandbox is on (still beaten by `--no-sandbox`). */
  readonly sandboxBackend?: SandboxBackend;
  readonly dryRun?: boolean;
  readonly passthrough?: readonly string[];
  /** `--verbose` → show nono's full sandbox capabilities banner instead of the one-line status. */
  readonly verbose?: boolean;
}

interface RunDeps {
  readonly cwd?: string;
  readonly home?: string;
  readonly which?: WhichFn;
  /** Whether stdout is a TTY (`cli.ts` passes `process.stdout.isTTY`) — rides the sbx exec argv as `-t`; default false. */
  readonly tty?: boolean;
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

/**
 * The sbx backend's materialization plan: the setup argvs `materializeRun`
 * runs before the final `sbx exec` (composed there, wrapping the pi argv).
 * `spec.piVersion` is null at plan time — the provision argv is recomposed at
 * materialize with the host pi version (see `MaterializeDeps.readPiVersion`)
 * so the guest install pins to it; the plan-time argv is the unpinned preview
 * dry-run prints, the same precedent as package `-e` entries, which also
 * resolve at materialize.
 */
export interface SbxRunPlan {
  readonly spec: SbxSpec;
  /** Resolved host pi path — the version-pin source for guest provisioning; never spawned in-guest. */
  readonly hostPiBin: string;
  readonly createArgv: readonly string[];
  readonly policyArgvs: ReadonlyArray<readonly string[]>;
  readonly provisionArgv: readonly string[];
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
  /** The generated per-agent nono profile to write before spawning; `null` unless the resolved backend is `'nono'`. */
  readonly profile: { readonly path: string; readonly content: string } | null;
  /** The sbx setup plan (see `SbxRunPlan`); `null` unless the resolved backend is `'sbx'`. */
  readonly sbx: SbxRunPlan | null;
  /** Settings.json `packages` resolved into an install plan; `null` when the folder declares none. */
  readonly packages: PackagesPlan | null;
  /** The single argv source: `composeArgv(plan.launch)` — package-entry-free until `materializeRun` recomposes it with resolved package entries. */
  readonly launch: LaunchSpec;
  readonly dryRun: boolean;
}

/**
 * Resolve the ref (bare alias name or path — see `../agent/aliases.js`), load
 * the agent folder, and compose the launch. Returns a plan; the caller
 * decides whether to print it (`--dry-run`) or materialize + spawn it.
 *
 * `--dry-run` only previews, so it deliberately skips the bin checks — you can
 * compose a command before nono/sbx/pi are installed.
 */
export async function planRun(flags: RunFlags, deps: RunDeps = {}): Promise<RunPlan> {
  const home = deps.home ?? homedir();
  const cwd = deps.cwd ?? process.cwd();
  const { dir, warnings: refWarnings } = await resolveAgentRef(flags.dir, { home, cwd });
  const folder = await loadAgentFolder(dir);
  const stateDir = stateDirFor(folder.dir, home);
  const { extensionsDir, sessionsDir, miseCacheDir } = statePaths(stateDir);
  const posture = resolvePosture(flags, folder);
  const dryRun = flags.dryRun ?? false;
  const bins = resolveBins(posture.backend, dryRun, deps.which);
  const launch = buildLaunch({
    folder,
    flags,
    backend: posture.backend,
    bins,
    stateDir,
    extensionsDir,
    sessionsDir,
    miseCacheDir
  });
  const isolation = await buildIsolation(posture, folder, {
    home,
    cwd,
    stateDir,
    profilePath: launch.profilePath,
    sbxBin: bins.sbxBin,
    hostPiBin: bins.piBin,
    tty: deps.tty ?? false
  });
  const packages = buildPackagesPlan(folder, stateDir);
  return {
    files: emitExtensionFiles(folder, posture.backend),
    extensionsDir,
    sessionsDir,
    warnings: [...refWarnings, ...posture.warnings, ...isolation.warnings],
    profile: isolation.profile,
    sbx: isolation.sbx,
    packages,
    launch,
    dryRun
  };
}

interface LaunchContext {
  readonly folder: AgentFolder;
  readonly flags: RunFlags;
  readonly backend: SandboxBackend | null;
  readonly bins: ResolvedBins;
  readonly stateDir: string;
  readonly extensionsDir: string;
  readonly sessionsDir: string;
  readonly miseCacheDir: string;
}

/** Resolve the generated-extension paths and profile path into the `LaunchSpec` `composeArgv` consumes. */
function buildLaunch(ctx: LaunchContext): LaunchSpec {
  const { folder, flags, backend, bins, stateDir, extensionsDir, sessionsDir, miseCacheDir } = ctx;
  return {
    folder,
    stateDir,
    extensionsDir,
    sessionsDir,
    miseCacheDir,
    backend,
    passthrough: flags.passthrough ?? [],
    nonoBin: bins.nonoBin,
    // The guest resolves `pi` on its own PATH (provisioning installed it
    // there); the host's resolved path is meaningless inside the microVM.
    piBin: backend === 'sbx' ? 'pi' : bins.piBin,
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
  readonly backend: SandboxBackend | null;
  readonly network: AgentNetwork | undefined;
  readonly warnings: readonly string[];
}

/** Resolve the backend decision and the network posture together, with their combined warnings. */
function resolvePosture(flags: RunFlags, folder: AgentFolder): ResolvedPosture {
  const { backend, warnings } = resolveBackend(flags, folder);
  const networkWarnings: string[] = [];
  const network = resolveNetwork(flags, folder, backend, networkWarnings);
  return {
    backend,
    network,
    warnings: withUnsandboxedNetworkWarning(backend !== null, network, [...warnings, ...networkWarnings])
  };
}

/**
 * Precedence: `--offline` > `--allow-host` > the resolved backend's own
 * sandbox file `network` > open default. CLI flags REPLACE the folder network
 * (no merge) so the effective posture is always unambiguous.
 */
function resolveNetwork(
  flags: RunFlags,
  folder: AgentFolder,
  backend: SandboxBackend | null,
  warnings: string[]
): AgentNetwork | undefined {
  if (flags.offline) return { block: true };
  const allowHost = readCliHostList(flags.allowHost ?? [], warnings);
  if (allowHost.length > 0) return { allowDomain: allowHost };
  return backend === 'sbx' ? folder.sbx.network : folder.sandbox.network;
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

interface ResolvedBackend {
  readonly backend: SandboxBackend | null;
  readonly warnings: readonly string[];
}

/**
 * Resolve which sandbox backend runs. Precedence: `--no-sandbox` (off) >
 * `--sandbox-backend <b>` (that backend, forced on) > `--sandbox` (folder
 * preference, default nono) > the folder's declared postures > restrictive
 * network flags force nono on > unsandboxed default with the loud
 * no-isolation warning.
 */
function resolveBackend(flags: RunFlags, folder: AgentFolder): ResolvedBackend {
  if (flags.noSandbox === true) return { backend: null, warnings: folder.warnings };
  // An explicit backend choice resolves any folder tie itself — the tie-break
  // warning (which names this very flag as the override) would be noise here.
  if (flags.sandboxBackend !== undefined) return { backend: flags.sandboxBackend, warnings: folder.warnings };
  const preference = folderBackendPreference(folder);
  if (flags.noSandbox === false || preference.backend !== null) {
    return { ...preference, backend: preference.backend ?? 'nono' };
  }
  return resolveUnconfiguredBackend(flags, folder, preference.warnings);
}

/**
 * The folder's declared backend: nono wins when both files enable a sandbox —
 * the host-fidelity default, overridable with `--sandbox-backend sbx` — with a
 * warning so the tie-break is never silent.
 */
function folderBackendPreference(folder: AgentFolder): ResolvedBackend {
  const nonoOn = folder.sandbox.posture === 'enabled';
  const sbxOn = folder.sbx.posture === 'enabled';
  if (nonoOn && sbxOn) {
    return {
      backend: 'nono',
      warnings: [
        ...folder.warnings,
        'both sandbox/nono.json and sandbox/sbx.json declare a sandbox — using nono (pass --sandbox-backend sbx to override)'
      ]
    };
  }
  return { backend: nonoOn ? 'nono' : sbxOn ? 'sbx' : null, warnings: folder.warnings };
}

/** No file turned a backend on: restrictive network flags force one anyway (nono, the host-fidelity default); otherwise unsandboxed, loudly. */
function resolveUnconfiguredBackend(
  flags: RunFlags,
  folder: AgentFolder,
  warnings: readonly string[]
): ResolvedBackend {
  const reason = unsandboxedReason(folder);
  if (hasRestrictiveNetworkFlags(flags)) {
    return {
      backend: 'nono',
      warnings: [
        ...warnings,
        `${reason} — sandbox forced on to enforce the requested network policy (--no-sandbox to override)`
      ]
    };
  }
  return {
    backend: null,
    warnings: [...warnings, `${reason} — agent is running without OS isolation (--sandbox to force enable)`]
  };
}

/**
 * Which file (if any) turned the backend off, for the unsandboxed warning. A
 * disabled file wins over the not-found message so the warning names the
 * deliberate opt-out rather than implying nothing was configured.
 */
function unsandboxedReason(folder: AgentFolder): string {
  if (folder.sandbox.posture === 'disabled') return 'sandbox disabled by sandbox/nono.json';
  if (folder.sbx.posture === 'disabled') return 'sandbox disabled by sandbox/sbx.json';
  return 'sandbox/nono.json or sbx.json not found';
}

export interface SbxRunResult {
  readonly exitCode: number;
  readonly stderr: string;
}

export interface MaterializeDeps {
  /** Runs a package install (e.g. `npm install`) in `cwd`; `cli.ts` always passes `runInstall` from `util/proc.js`. */
  readonly install?: (command: readonly string[], cwd: string) => Promise<void>;
  /** Runs one sbx setup command (create/policy/provision), capturing stderr; `cli.ts` passes `runCapture` from `util/proc.js`. */
  readonly run?: (argv: readonly string[]) => Promise<SbxRunResult>;
  /** Reads the host pi version (`cli.ts` passes its `--version` reader) to pin the guest install; absent → unpinned provisioning. */
  readonly readPiVersion?: (piBin: string) => Promise<string | null>;
}

/**
 * Write the generated extensions (replacing stale ones), ensure the sessions
 * dir, and — per backend — (re)write the generated per-agent nono profile
 * that `nono run --profile` points at, or run the sbx setup sequence
 * (create/policy/provision) and wrap the final argv in `sbx exec`. When the
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
  if (plan.sbx !== null) await runSbxSetup(plan.sbx, deps);
  // `plan.extensionsDir`/`plan.sessionsDir` are authoritative (see `RunPlan`
  // docs): re-assert them onto `launch` here so a plan whose dirs were
  // overridden after `planRun` still gets a composed argv that agrees with
  // what was actually written to disk above, instead of whatever `launch` had
  // baked in at `planRun` time.
  const launch: LaunchSpec = { ...plan.launch, extensionsDir: plan.extensionsDir, sessionsDir: plan.sessionsDir };
  const result =
    plan.packages === null
      ? { argv: composeArgv(launch), warnings: [] }
      : await installAndResolvePackages(plan.packages, launch, deps);
  if (plan.sbx === null) return result;
  return { argv: composeSbxExecArgv(plan.sbx.spec, result.argv), warnings: result.warnings };
}

/**
 * Run the sbx setup sequence: create (a name collision is attach, not failure
 * — the mount-set-hashed name guarantees an existing sandbox already has this
 * run's exact mounts), then the idempotent per-sandbox policy rules, then
 * provisioning — recomposed with the host pi version when `readPiVersion` is
 * provided so the guest install pins to it.
 */
async function runSbxSetup(sbx: SbxRunPlan, deps: MaterializeDeps): Promise<void> {
  const run = deps.run;
  if (run === undefined) throw new Error('An sbx-backend run needs a command runner but none was provided');
  const created = await run(sbx.createArgv);
  if (created.exitCode !== 0 && !isSbxAlreadyExistsError(created.stderr)) {
    throw new Error(`Failed to create sbx sandbox ${sbx.spec.name}: ${created.stderr.trim()}`);
  }
  for (const argv of sbx.policyArgvs) {
    await runSbxStep(run, argv, `apply sbx network policy (${sbx.spec.name})`);
  }
  await runSbxStep(run, await resolveProvisionArgv(sbx, deps), `provision pi in sbx sandbox ${sbx.spec.name}`);
}

async function runSbxStep(
  run: NonNullable<MaterializeDeps['run']>,
  argv: readonly string[],
  what: string
): Promise<void> {
  const result = await run(argv);
  if (result.exitCode !== 0) throw new Error(`Failed to ${what}: ${result.stderr.trim()}`);
}

/** Pin the guest pi install to the host's version when the reader dep is present; the plan-time (unpinned) argv otherwise. */
async function resolveProvisionArgv(sbx: SbxRunPlan, deps: MaterializeDeps): Promise<readonly string[]> {
  if (deps.readPiVersion === undefined) return sbx.provisionArgv;
  const piVersion = await deps.readPiVersion(sbx.hostPiBin);
  return composeSbxProvisionArgv({ ...sbx.spec, piVersion });
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
  readonly sbxBin: string;
}

/**
 * Verify the required bins and resolve their spawn paths. Only the active
 * backend's wrapper bin is required — `nono` for `'nono'`, `sbx` for `'sbx'`
 * — while `pi` is required on every run: it spawns directly when unsandboxed
 * and under nono (resolved path, mise-shim fallback included — see
 * `util/which.ts` and `LaunchSpec.piBin`), and under sbx its resolved host
 * path sources the guest version pin (see `MaterializeDeps.readPiVersion`)
 * even though the guest spawns its own PATH-resolved `pi`. `--dry-run` only
 * previews, so it deliberately skips the checks — you can compose a command
 * before the bins are installed.
 */
function resolveBins(backend: SandboxBackend | null, dryRun: boolean, which?: WhichFn): ResolvedBins {
  if (dryRun) return { nonoBin: 'nono', piBin: 'pi', sbxBin: 'sbx' };
  return {
    nonoBin: backend === 'nono' ? requireBin('nono', which) : 'nono',
    sbxBin: backend === 'sbx' ? requireBin('sbx', which) : 'sbx',
    piBin: requireBin('pi', which)
  };
}

interface IsolationContext {
  readonly home: string;
  readonly cwd: string;
  readonly stateDir: string;
  readonly profilePath: string;
  readonly sbxBin: string;
  readonly hostPiBin: string;
  readonly tty: boolean;
}

interface IsolationPlan {
  readonly profile: { readonly path: string; readonly content: string } | null;
  readonly sbx: SbxRunPlan | null;
  readonly warnings: readonly string[];
}

/**
 * The backend-specific halves of the plan: the generated nono profile, or the
 * sbx create/policy/provision argvs plus the sbx warn-and-drop disclosures
 * (nono-only grants and network keys the VM boundary cannot honor). The
 * linked-git-dir resolution is shared — both backends need the real git dir
 * reachable when cwd is a worktree/submodule checkout: a profile grant on
 * nono, an extra rw mount on sbx.
 */
async function buildIsolation(
  posture: ResolvedPosture,
  folder: AgentFolder,
  ctx: IsolationContext
): Promise<IsolationPlan> {
  const linkedGitDir = posture.backend !== null ? await resolveLinkedGitDir(ctx.cwd) : undefined;
  const profile = sandboxPlan(posture.backend === 'nono', folder, posture.network, {
    home: ctx.home,
    cwd: ctx.cwd,
    stateDir: ctx.stateDir,
    profilePath: ctx.profilePath,
    ...(linkedGitDir !== undefined ? { linkedGitDir } : {})
  });
  if (posture.backend !== 'sbx') return { profile, sbx: null, warnings: [] };
  const sbx = buildSbxPlan(posture.network, folder, {
    ...ctx,
    ...(linkedGitDir !== undefined ? { linkedGitDir } : {})
  });
  return {
    profile,
    sbx,
    warnings: [...sbxNetworkWarnings(posture.network), ...sbxGrantWarnings(folder.sbx.filesystem)]
  };
}

interface SbxPlanContext extends IsolationContext {
  readonly linkedGitDir?: string;
}

/**
 * Compose the sbx setup plan from the folder's `sandbox/sbx.json` grants: the
 * mount set (cwd, agent dir, state dir, `~/.pi/agent`, linked git dir,
 * grants), the mount-set-hashed sandbox name, and the create/policy/provision
 * argvs — see `sbx/compose.ts` for each composition's contract.
 */
function buildSbxPlan(network: AgentNetwork | undefined, folder: AgentFolder, ctx: SbxPlanContext): SbxRunPlan {
  const mounts = composeSbxMounts({
    cwd: ctx.cwd,
    agentDir: folder.dir,
    stateDir: ctx.stateDir,
    home: ctx.home,
    grants: folder.sbx.filesystem,
    ...(ctx.linkedGitDir !== undefined ? { linkedGitDir: ctx.linkedGitDir } : {})
  });
  const spec: SbxSpec = {
    sbxBin: ctx.sbxBin,
    name: sbxSandboxName(basename(ctx.stateDir), mounts),
    cwd: ctx.cwd,
    home: ctx.home,
    mounts,
    ...(network !== undefined ? { network } : {}),
    piVersion: null,
    tty: ctx.tty
  };
  return {
    spec,
    hostPiBin: ctx.hostPiBin,
    createArgv: composeSbxCreateArgv(spec),
    policyArgvs: composeSbxPolicyArgvs(spec),
    provisionArgv: composeSbxProvisionArgv(spec)
  };
}

/**
 * Nono-only artifact of the plan: the generated per-agent nono profile
 * (path + content; grants, network, and seatbelt rules baked in). Runs are
 * silent by default (`--silent` is passed to nono); `--verbose` shows nono's
 * capabilities banner (grants + network mode), and the generated profile file
 * is the complete audit surface (seatbelt rules never appear in the banner
 * even with `--verbose`). Returns `null` for other backends, which need no
 * profile.
 *
 * Fails fast on a degenerate cwd (see `findDegenerateSandboxCwd`) before
 * baking it in as the profile's cwd `allow` grant: nono itself refuses to
 * start when a grant overlaps its protected state root, and that refusal is
 * opaque — a cradle-level error here names the offending directory instead.
 * The sbx guest cannot overlap nono's state root, so the check is nono-only.
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
    ...(network !== undefined ? { network } : {}),
    ...(ctx.linkedGitDir !== undefined ? { linkedGitDir: ctx.linkedGitDir } : {})
  });
  return { path: ctx.profilePath, content };
}

function emitExtensionFiles(folder: AgentFolder, backend: SandboxBackend | null): TreeFile[] {
  return [
    ...(folder.providersJson !== null
      ? [
          {
            rel: 'providers.ts',
            content: emitProvidersExtension(folder.providersJson, { rewriteLocalhostBaseUrls: backend === 'sbx' })
          }
        ]
      : []),
    ...(backend === 'nono'
      ? [
          {
            rel: AGENT_BROWSER_NONO_FALLBACK_EXTENSION_FILE,
            content: emitAgentBrowserNonoFallbackExtension()
          }
        ]
      : [])
  ];
}
