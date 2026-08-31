// `cradle schedule <action>`: compile an agent folder's `schedule/*.md` into
// OS timers — launchd LaunchAgents on macOS, systemd `--user` timers on
// Linux (see `../schedule/launchd.js`/`../schedule/systemd.js`) — and
// list/install/remove/fire them. Mirrors `commands/run.ts`'s split: a pure-ish
// `planSchedule` (folder + schedule loading, per-task `TimerPlan`
// composition, list-row building) and a side-effecting `materializeSchedule`
// (writes the timer files, runs launchctl/systemctl) so the CLI can preview a
// `--dry-run` write plan and tests can assert both halves in-process without
// ever spawning a real `launchctl`/`systemctl`.

import { exists, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

import { resolveAgentRef } from '../agent/aliases.js';
import { loadAgentFolder, type AgentFolder } from '../agent/folder.js';
import { loadSchedules, missingScheduleDirError, type Schedule } from '../agent/schedules.js';
import { agentId, stateDirFor } from '../agent/state.js';
import { nextFire, parseCron, type CronFields } from '../schedule/cron.js';
import { composeLaunchdTimer } from '../schedule/launchd.js';
import { composeLingerCheckArgv, composeSystemdTimer, LINGER_HINT } from '../schedule/systemd.js';
import type { TimerContext, TimerFile, TimerPlan, TimerStep } from '../schedule/timer.js';
import { getErrorMessage } from '../setup/utils.js';
import { requireBin, type WhichFn } from '../util/which.js';

/** `cradle schedule run` is NOT here: it executes the task in-process through `commands/run.ts`, so `cli.ts` routes it there instead. */
export type ScheduleAction = 'list' | 'install' | 'remove';

/** launchd (macOS) and systemd `--user` (Linux) are the only supported timer backends. */
type SupportedSchedulePlatform = 'darwin' | 'linux';

export interface ScheduleFlags {
  readonly dir: string;
  readonly action: ScheduleAction;
  /** Required for `run`; an optional filter for `install`/`remove` (every schedule when absent); unused for `list`, which always lists everything. */
  readonly slug?: string;
  /** `install` only — print the write plan and touch nothing. */
  readonly dryRun?: boolean;
}

interface ScheduleDeps {
  readonly cwd?: string;
  readonly home?: string;
  readonly which?: WhichFn;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  /** The OS account name `loginctl show-user <user>` checks — default the real login name. */
  readonly user?: string;
  readonly now?: () => Date;
}

/** One `cradle schedule list` row — a broken cron is reported inline rather than aborting the whole listing. */
export interface ScheduleRow {
  readonly slug: string;
  readonly name: string;
  readonly cron: string;
  readonly cwd: string;
  readonly cronError?: string;
  readonly nextFire: Date | null;
  readonly installed: boolean;
}

/** One resolved schedule's composed timer, for `install`/`remove`/`run`. */
interface ScheduleTarget {
  readonly schedule: Schedule;
  readonly timerPlan: TimerPlan;
  /** Not carried by `TimerPlan` itself — `materializeSchedule` `mkdir -p`s its parent before running `installSteps`. */
  readonly logPath: string;
}

export interface SchedulePlan {
  readonly action: ScheduleAction;
  readonly folder: AgentFolder;
  readonly platform: SupportedSchedulePlatform;
  /** Populated for `list` only. */
  readonly rows: readonly ScheduleRow[];
  /** Populated for `install`/`remove`/`run` — every selected schedule with its composed `TimerPlan`. */
  readonly targets: readonly ScheduleTarget[];
  readonly warnings: readonly string[];
  readonly dryRun: boolean;
  /** `install` on Linux only — `materializeSchedule` runs this first and warns `LINGER_HINT` when lingering is off. */
  readonly lingerCheckArgv: readonly string[] | null;
}

function assertSupportedPlatform(platform: NodeJS.Platform): asserts platform is SupportedSchedulePlatform {
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(
      `Scheduled tasks are not supported on ${platform} — launchd (macOS) and systemd (Linux) are the supported timer backends`
    );
  }
}

interface ScheduleContextBase {
  readonly folder: AgentFolder;
  readonly schedules: readonly Schedule[];
  readonly warnings: readonly string[];
  readonly stateDir: string;
}

/** Resolve the ref and load the agent folder's `schedule/` — the read-only half every action shares. */
async function loadScheduleContext(flags: ScheduleFlags, home: string, cwd: string): Promise<ScheduleContextBase> {
  const { dir, warnings: refWarnings } = await resolveAgentRef(flags.dir, { home, cwd });
  const folder = await loadAgentFolder(dir);
  if (folder.scheduleDir === null) {
    throw await missingScheduleDirError(folder.dir);
  }
  const { schedules, warnings: loadWarnings } = await loadSchedules(folder.scheduleDir, home);
  return { folder, schedules, warnings: [...refWarnings, ...loadWarnings], stateDir: stateDirFor(folder.dir, home) };
}

/** A `Schedule` → `TimerContext` builder closing over the run-wide fields (bin, home, uid) every schedule shares. */
function contextFactory(
  base: ScheduleContextBase,
  params: { readonly cradleBin: string; readonly home: string; readonly uid: number }
): (schedule: Schedule) => TimerContext {
  return schedule => ({
    schedule,
    agentId: agentId(base.folder.dir),
    agentDir: base.folder.dir,
    cradleBin: params.cradleBin,
    logPath: join(base.stateDir, 'schedule', `${schedule.slug}.log`),
    home: params.home,
    uid: params.uid
  });
}

interface ScheduleActionContext {
  readonly flags: ScheduleFlags;
  readonly base: ScheduleContextBase;
  readonly contextFor: (schedule: Schedule) => TimerContext;
  readonly platform: SupportedSchedulePlatform;
  readonly deps: ScheduleDeps;
  readonly dryRun: boolean;
}

/**
 * Resolve the ref, load the agent folder's `schedule/`, and — for every
 * action but `list` — compose the selected schedule(s)' `TimerPlan`s. `list`
 * never throws on a single bad schedule (see `buildScheduleRow`); every other
 * action does, since installing/removing/firing a broken timer can't proceed.
 */
export async function planSchedule(flags: ScheduleFlags, deps: ScheduleDeps = {}): Promise<SchedulePlan> {
  const resolved = resolveScheduleDeps(flags, deps);
  const base = await loadScheduleContext(flags, resolved.home, resolved.cwd);
  const cradleBin = requiresResolvedCradleBin(flags, resolved.dryRun) ? requireBin('cradle', deps.which) : 'cradle';
  const contextFor = contextFactory(base, { cradleBin, home: resolved.home, uid: resolved.uid });
  const ctx: ScheduleActionContext = {
    flags,
    base,
    contextFor,
    platform: resolved.platform,
    deps,
    dryRun: resolved.dryRun
  };
  return flags.action === 'list' ? planScheduleList(ctx) : planScheduleAction(ctx);
}

interface ResolvedScheduleDeps {
  readonly home: string;
  readonly cwd: string;
  readonly platform: SupportedSchedulePlatform;
  readonly uid: number;
  readonly dryRun: boolean;
}

/** Apply every default (`homedir()`, `process.cwd()`, `process.platform`, `process.getuid()`) in one place, asserting the platform is supported along the way. */
function resolveScheduleDeps(flags: ScheduleFlags, deps: ScheduleDeps): ResolvedScheduleDeps {
  const platform = deps.platform ?? process.platform;
  assertSupportedPlatform(platform);
  return {
    home: deps.home ?? homedir(),
    cwd: deps.cwd ?? process.cwd(),
    platform,
    uid: deps.uid ?? defaultUid(),
    dryRun: flags.dryRun ?? false
  };
}

function defaultUid(): number {
  return process.getuid?.() ?? 0;
}

/**
 * Only `install` writes `cradleBin` into a file launchd/systemd reads back
 * later (their own environment carries no shell PATH, so it must be a real
 * resolved path there) — `list`/`remove`/`run` never persist it, so a bare
 * `cradle` placeholder is harmless and keeps those actions usable even when
 * `cradle` itself isn't resolvable via `which` (e.g. invoked by absolute
 * path). `--dry-run` previews `install`'s write without resolving anything,
 * same precedent as `commands/run.ts`'s `resolveBins`.
 */
function requiresResolvedCradleBin(flags: ScheduleFlags, dryRun: boolean): boolean {
  return flags.action === 'install' && !dryRun;
}

async function planScheduleList(ctx: ScheduleActionContext): Promise<SchedulePlan> {
  const now = ctx.deps.now ?? ((): Date => new Date());
  const rows = await Promise.all(
    ctx.base.schedules.map(schedule => buildScheduleRow(schedule, ctx.contextFor(schedule), ctx.platform, now))
  );
  return {
    action: 'list',
    folder: ctx.base.folder,
    platform: ctx.platform,
    rows,
    targets: [],
    warnings: ctx.base.warnings,
    dryRun: ctx.dryRun,
    lingerCheckArgv: null
  };
}

function planScheduleAction(ctx: ScheduleActionContext): SchedulePlan {
  const targets = selectSchedules(ctx.base.schedules, ctx.flags).map(schedule =>
    buildScheduleTarget(schedule, ctx.contextFor(schedule), ctx.platform)
  );
  const lingerCheckArgv =
    ctx.flags.action === 'install' && ctx.platform === 'linux'
      ? composeLingerCheckArgv(ctx.deps.user ?? userInfo().username)
      : null;
  return {
    action: ctx.flags.action,
    folder: ctx.base.folder,
    platform: ctx.platform,
    rows: [],
    targets,
    warnings: ctx.base.warnings,
    dryRun: ctx.dryRun,
    lingerCheckArgv
  };
}

/** `flags.slug` filters to one schedule (throwing the aliases.ts-style unknown-slug message when it matches none); absent selects every schedule. `run` requires a slug — firing "every schedule now" is not a sensible default. */
function selectSchedules(schedules: readonly Schedule[], flags: ScheduleFlags): readonly Schedule[] {
  if (flags.slug === undefined) return schedules;
  const schedule = schedules.find(candidate => candidate.slug === flags.slug);
  if (schedule === undefined) throw new Error(unknownScheduleMessage(flags.slug, schedules));
  return [schedule];
}

/** Mirrors `agent/aliases.ts`'s `bothMissedMessage` style — names the requested slug and lists what's available. */
function unknownScheduleMessage(slug: string, schedules: readonly Schedule[]): string {
  const known =
    schedules.length > 0
      ? ` (available: ${schedules.map(schedule => schedule.slug).join(', ')})`
      : ' (schedule/ is empty)';
  return `Unknown schedule "${slug}"${known}`;
}

function buildScheduleTarget(
  schedule: Schedule,
  context: TimerContext,
  platform: SupportedSchedulePlatform
): ScheduleTarget {
  return {
    schedule,
    timerPlan: composeTimerPlan(context, platform, parseCron(schedule.cron)),
    logPath: context.logPath
  };
}

function composeTimerPlan(context: TimerContext, platform: SupportedSchedulePlatform, fields: CronFields): TimerPlan {
  return platform === 'darwin' ? composeLaunchdTimer(context, fields) : composeSystemdTimer(context, fields);
}

/** One `list` row. A cron that fails to parse is reported inline (`cronError`) instead of throwing — one bad task must not hide the others. */
async function buildScheduleRow(
  schedule: Schedule,
  context: TimerContext,
  platform: SupportedSchedulePlatform,
  now: () => Date
): Promise<ScheduleRow> {
  const base = { slug: schedule.slug, name: schedule.name, cron: schedule.cron, cwd: schedule.cwd };
  // Composing the timer is inside the guard, not just parsing: both emitters
  // reject expressions their backend cannot encode (launchd's dict cap,
  // systemd's newline check), and an unlistable schedule must be reported in
  // its own row rather than aborting every other row in the folder.
  try {
    const fields = parseCron(schedule.cron);
    const timerPlan = composeTimerPlan(context, platform, fields);
    return { ...base, nextFire: nextFire(fields, now()), installed: await allFilesExist(timerPlan.files) };
  } catch (error) {
    return { ...base, cronError: getErrorMessage(error), nextFire: null, installed: false };
  }
}

async function allFilesExist(files: readonly TimerFile[]): Promise<boolean> {
  const checks = await Promise.all(files.map(file => exists(file.path)));
  return checks.every(Boolean);
}

/** Format `list`'s rows into the printed report — pure, mirroring `doctor.ts`'s `runDoctor`/`formatDoctorReport` split. */
export function formatScheduleList(rows: readonly ScheduleRow[]): string {
  if (rows.length === 0) return 'No schedules found.';
  return rows.map(formatScheduleRow).join('\n\n');
}

function formatScheduleRow(row: ScheduleRow): string {
  const status = row.installed ? 'installed' : 'not installed';
  const cronLine = row.cronError !== undefined ? `INVALID: ${row.cronError}` : `next: ${formatNextFire(row.nextFire)}`;
  return [
    `${row.slug} — ${row.name}`,
    `  cron:  ${row.cron}  (${cronLine})`,
    `  cwd:   ${row.cwd}`,
    `  timer: ${status}`
  ].join('\n');
}

function formatNextFire(when: Date | null): string {
  return when === null ? 'never (cannot fire within the next year)' : when.toLocaleString();
}

export interface ScheduleRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface MaterializeScheduleDeps {
  /** Runs one launchctl/systemctl/loginctl argv, capturing both streams; `cli.ts` passes `runCaptureAll` from `util/proc.js`. */
  readonly run?: (argv: readonly string[]) => Promise<ScheduleRunResult>;
}

export interface MaterializeScheduleResult {
  readonly warnings: string[];
}

/**
 * Apply a non-`list` plan's side effects. The caller is responsible for
 * skipping this entirely on `--dry-run` (`plan.dryRun`) — same precedent as
 * `commands/run.ts`'s `materializeRun`, which `cli.ts` never calls when
 * `plan.dryRun` is set.
 */
export async function materializeSchedule(
  plan: SchedulePlan,
  deps: MaterializeScheduleDeps = {}
): Promise<MaterializeScheduleResult> {
  // A dry-run plan is a preview, and `remove`'s side effects (bootout + unlink)
  // are unrecoverable. Refusing here means a caller that forgets to branch on
  // `plan.dryRun` fails loudly instead of silently uninstalling.
  if (plan.dryRun) throw new Error('Cannot materialize a --dry-run schedule plan; it is a preview only');
  if (plan.action === 'remove') return { warnings: await materializeRemove(plan, deps) };
  if (plan.action === 'install') return { warnings: await materializeInstall(plan, deps) };
  return { warnings: [] };
}

async function materializeInstall(plan: SchedulePlan, deps: MaterializeScheduleDeps): Promise<string[]> {
  const run = requireRunner(deps);
  const warnings = await runLingerCheck(plan.lingerCheckArgv, run);
  for (const target of plan.targets) {
    await writeTimerFiles(target.timerPlan.files);
    await mkdir(dirname(target.logPath), { recursive: true });
    await runSteps(run, target.timerPlan.installSteps, `install schedule "${target.schedule.slug}"`);
  }
  return warnings;
}

/**
 * The linger probe is advisory, so it must never fail the install it precedes.
 * `loginctl` is absent on a container or a non-logind distro, where `Bun.spawn`
 * throws ENOENT rather than exiting non-zero — without this catch, a hint about
 * timer lifetime would abort a run before a single file was written.
 */
async function runLingerCheck(argv: readonly string[] | null, run: ScheduleRunner): Promise<string[]> {
  if (argv === null) return [];
  try {
    const result = await run(argv);
    return result.stdout.includes('Linger=yes') ? [] : [LINGER_HINT];
  } catch {
    return [LINGER_HINT];
  }
}

async function materializeRemove(plan: SchedulePlan, deps: MaterializeScheduleDeps): Promise<string[]> {
  const run = requireRunner(deps);
  for (const target of plan.targets) {
    await runSteps(run, target.timerPlan.removeSteps, `remove schedule "${target.schedule.slug}"`);
    await Promise.all(target.timerPlan.files.map(file => rm(file.path, { force: true })));
  }
  return [];
}

async function writeTimerFiles(files: readonly TimerFile[]): Promise<void> {
  for (const file of files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, 'utf8');
  }
}

type ScheduleRunner = NonNullable<MaterializeScheduleDeps['run']>;

function requireRunner(deps: MaterializeScheduleDeps): ScheduleRunner {
  if (deps.run === undefined) throw new Error('A schedule install/remove needs a command runner but none was provided');
  return deps.run;
}

async function runSteps(run: ScheduleRunner, steps: readonly TimerStep[], what: string): Promise<void> {
  for (const step of steps) {
    const result = await run(step.argv);
    if (result.exitCode !== 0 && step.ignoreFailure !== true) {
      throw new Error(`Failed to ${what} (${step.argv.join(' ')}): ${result.stderr.trim()}`);
    }
  }
}
