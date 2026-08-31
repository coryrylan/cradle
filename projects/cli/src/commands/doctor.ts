import { lookupBin, type WhichFn } from '../util/which.js';

export interface DoctorCheck {
  readonly name: string;
  readonly bin: string;
  readonly required: boolean;
  readonly found: string | null;
  readonly version: string | null;
  readonly note?: string;
}

interface DoctorDeps {
  readonly which?: WhichFn;
  /** Read a bin's version output (default argv `--version`; sbx passes `['version']`); injected so in-process tests never spawn. */
  readonly readVersion?: (binPath: string, args?: readonly string[]) => Promise<string | null>;
  /** Injectable so both the launchd and systemd probes are exercised from any one machine's tests. */
  readonly platform?: NodeJS.Platform;
}

/**
 * mise is not invoked by cradle directly — it is the recommended manager for
 * installing `pi`/`nono`: cradle falls back to mise's shims when resolving them
 * and the `cradle-pi` sandbox profile grants mise's trees so a sandboxed pi
 * finds its runtime. So doctor reports it as recommended, not a hard failure.
 */
const MISE_RECOMMENDED_NOTE =
  'recommended: the supported way to install pi/nono — cradle resolves them from mise shims and the sandbox profile assumes a mise-managed install';
const NONO_SANDBOX_NOTE =
  'required for sandboxed runs (a folder declaring sandbox/nono.json, or --sandbox/--offline/--allow-host); not needed otherwise';
const SBX_SANDBOX_NOTE =
  'required for sbx-backend runs (a folder declaring sandbox/sbx.json, or --sandbox-backend sbx); not needed otherwise';
const LAUNCHD_SCHEDULE_NOTE =
  'recommended for `cradle schedule`: installs schedule/*.md tasks as launchd LaunchAgents; not needed otherwise';
const SYSTEMD_SCHEDULE_NOTE =
  'recommended for `cradle schedule`: installs schedule/*.md tasks as systemd --user timers; not needed otherwise';

/** The scheduling backend bin for a platform, or `null` where `cradle schedule` has no supported backend (skip the check entirely). */
function scheduleBackendBin(platform: NodeJS.Platform): 'launchctl' | 'systemctl' | null {
  if (platform === 'darwin') return 'launchctl';
  if (platform === 'linux') return 'systemctl';
  return null;
}

function scheduleBackendNote(bin: 'launchctl' | 'systemctl'): string {
  return bin === 'launchctl' ? LAUNCHD_SCHEDULE_NOTE : SYSTEMD_SCHEDULE_NOTE;
}

/** A recommended (not required) check: `found`/`version` from the probe, `note` attached only when missing. */
function optionalCheck(name: string, found: string | null, version: string | null, note: string): DoctorCheck {
  return { name, bin: name, required: false, found, version, ...(found ? {} : { note }) };
}

interface ProbedBins {
  readonly piPath: string | null;
  readonly nonoPath: string | null;
  readonly sbxPath: string | null;
  readonly misePath: string | null;
  readonly scheduleBin: 'launchctl' | 'systemctl' | null;
  readonly schedulePath: string | null;
}

function probeBins(deps: DoctorDeps): ProbedBins {
  const find = (bin: string): string | null => lookupBin(bin, deps.which);
  const scheduleBin = scheduleBackendBin(deps.platform ?? process.platform);
  return {
    piPath: find('pi'),
    nonoPath: find('nono'),
    sbxPath: find('sbx'),
    misePath: find('mise'),
    scheduleBin,
    schedulePath: scheduleBin !== null ? find(scheduleBin) : null
  };
}

/**
 * Probe the environment cradle depends on: `pi` (always required), `nono` and
 * `sbx` (each required only for runs on its backend — see the notes), `mise`
 * (recommended toolchain manager), and the platform's scheduling backend
 * (`launchctl`/`systemctl`, recommended for `cradle schedule`; skipped
 * entirely on a platform with neither).
 */
export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const version = async (found: string | null, args?: readonly string[]): Promise<string | null> =>
    found !== null && deps.readVersion ? deps.readVersion(found, args) : null;
  const bins = probeBins(deps);
  // sbx has no `--version` flag; its version rides the `sbx version` subcommand.
  const [piVersion, nonoVersion, sbxVersion, miseVersion, scheduleVersion] = await Promise.all([
    version(bins.piPath),
    version(bins.nonoPath),
    version(bins.sbxPath, ['version']),
    version(bins.misePath),
    version(bins.schedulePath)
  ]);
  return [
    { name: 'pi', bin: 'pi', required: true, found: bins.piPath, version: piVersion },
    optionalCheck('nono', bins.nonoPath, nonoVersion, NONO_SANDBOX_NOTE),
    optionalCheck('sbx', bins.sbxPath, sbxVersion, SBX_SANDBOX_NOTE),
    optionalCheck('mise', bins.misePath, miseVersion, MISE_RECOMMENDED_NOTE),
    ...(bins.scheduleBin !== null
      ? [optionalCheck(bins.scheduleBin, bins.schedulePath, scheduleVersion, scheduleBackendNote(bins.scheduleBin))]
      : [])
  ];
}

// A bin whose name is longer than the rest (`launchctl`, `systemctl`) must not
// shove its own column out of line, so the width comes from the widest name
// actually being reported rather than a constant.
const MIN_NAME_WIDTH = 8;

function formatCheck(check: DoctorCheck, width: number): string {
  const name = check.name.padEnd(width);
  // `launchctl` and `systemctl` ship with the OS and expose no version flag;
  // an empty version column reads better than a `?` standing in for one that
  // was never meaningful.
  const version = check.version !== null ? `${check.version}  ` : '';
  const line = check.found
    ? `✓ ${name} ${version}${check.found}`
    : check.required
      ? `✗ ${name} MISSING (required)`
      : `○ ${name} not found (recommended)`;
  return check.note ? `${line}\n  ⚠ ${check.note}` : line;
}

export function formatDoctorReport(checks: readonly DoctorCheck[]): string {
  const width = Math.max(MIN_NAME_WIDTH, ...checks.map(check => check.name.length));
  return checks.map(check => formatCheck(check, width)).join('\n');
}

/** Exit non-zero when any required dependency is missing. */
export function doctorExitCode(checks: readonly DoctorCheck[]): number {
  return checks.some(check => check.required && !check.found) ? 1 : 0;
}
