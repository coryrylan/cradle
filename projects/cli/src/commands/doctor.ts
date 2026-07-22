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

/**
 * Probe the environment cradle depends on: `pi` (always required), `nono` and
 * `sbx` (each required only for runs on its backend — see the notes), and
 * `mise` (recommended toolchain manager).
 */
export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const find = (bin: string): string | null => lookupBin(bin, deps.which);
  const version = async (found: string | null, args?: readonly string[]): Promise<string | null> =>
    found !== null && deps.readVersion ? deps.readVersion(found, args) : null;
  const piPath = find('pi');
  const nonoPath = find('nono');
  const sbxPath = find('sbx');
  const misePath = find('mise');
  // sbx has no `--version` flag; its version rides the `sbx version` subcommand.
  const [piVersion, nonoVersion, sbxVersion, miseVersion] = await Promise.all([
    version(piPath),
    version(nonoPath),
    version(sbxPath, ['version']),
    version(misePath)
  ]);
  return [
    { name: 'pi', bin: 'pi', required: true, found: piPath, version: piVersion },
    {
      name: 'nono',
      bin: 'nono',
      required: false,
      found: nonoPath,
      version: nonoVersion,
      ...(nonoPath ? {} : { note: NONO_SANDBOX_NOTE })
    },
    {
      name: 'sbx',
      bin: 'sbx',
      required: false,
      found: sbxPath,
      version: sbxVersion,
      ...(sbxPath ? {} : { note: SBX_SANDBOX_NOTE })
    },
    {
      name: 'mise',
      bin: 'mise',
      required: false,
      found: misePath,
      version: miseVersion,
      ...(misePath ? {} : { note: MISE_RECOMMENDED_NOTE })
    }
  ];
}

function formatCheck(check: DoctorCheck): string {
  const line = check.found
    ? `✓ ${check.name.padEnd(8)} ${check.version ?? '?'}  ${check.found}`
    : check.required
      ? `✗ ${check.name.padEnd(8)} MISSING (required)`
      : `○ ${check.name.padEnd(8)} not found (recommended)`;
  return check.note ? `${line}\n  ⚠ ${check.note}` : line;
}

export function formatDoctorReport(checks: readonly DoctorCheck[]): string {
  return checks.map(formatCheck).join('\n');
}

/** Exit non-zero when any required dependency is missing. */
export function doctorExitCode(checks: readonly DoctorCheck[]): number {
  return checks.some(check => check.required && !check.found) ? 1 : 0;
}
