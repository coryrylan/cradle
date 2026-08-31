// Composes the systemd user-unit artifacts for a scheduled agent run — the
// Linux half of the shared TimerPlan contract in `./timer.js`. Pure
// composition, like `sbx/compose.ts` and `nono/profiles.ts`: no filesystem
// writes, no `systemctl` spawning — that's the command layer's job.

import { join } from 'node:path';

import type { CronField, CronFields } from './cron.js';
import type { TimerContext, TimerPlan } from './timer.js';

/** Thrown when a value bound for a unit file contains a raw newline, which would corrupt the ini-style syntax. */
export class SystemdUnitValueError extends Error {
  constructor(value: string) {
    super(`systemd unit values cannot contain a newline, got ${JSON.stringify(value)}`);
    this.name = 'SystemdUnitValueError';
  }
}

// `%` doubles because systemd expands `%`-specifiers (`%h`, `%u`, ...) in
// unit file values; a raw `%` in a path or name would otherwise be
// reinterpreted instead of taken literally.
function escapeSystemdValue(value: string): string {
  if (value.includes('\n')) throw new SystemdUnitValueError(value);
  return value.replaceAll('%', '%%');
}

/**
 * Quote one `ExecStart` argument. Command lines are the one unit-file setting
 * systemd tokenizes on whitespace, so an unquoted agent dir or binary path
 * containing a space would silently split into two arguments. Single-value
 * settings (`WorkingDirectory`, `StandardOutput`) take the rest of the line
 * verbatim and must NOT be quoted — see systemd.syntax(7).
 */
function quoteExecArg(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function zeroPad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Comma-joined, ascending, zero-padded — `*` for an unconstrained field. Values arrive pre-sorted from `parseCron`. */
function renderNumericField(field: CronField): string {
  return field === null ? '*' : field.map(zeroPad).join(',');
}

const DAY_OF_WEEK_NAMES: readonly [string, string, string, string, string, string, string] = [
  'Sun',
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat'
];

// `CronFields.dayOfWeek` is contractually 0-6 (cron.ts normalizes 7 -> 0), so
// this index is always in range; the guard exists only to satisfy
// `noUncheckedIndexedAccess`, not because the value is ever untrusted here.
function dayOfWeekName(value: number): string {
  const name = DAY_OF_WEEK_NAMES[value];
  if (name === undefined) throw new Error(`Day-of-week value out of range: ${String(value)}`);
  return name;
}

function renderDayOfWeekField(field: CronField): string | undefined {
  return field === null ? undefined : field.map(dayOfWeekName).join(',');
}

/**
 * `[DOW] YYYY-MM-DD HH:MM:SS` in systemd calendar syntax. Year is always
 * `*`; systemd's native lists/ranges/steps mean, unlike launchd, no
 * cartesian expansion is ever needed here.
 */
function composeOnCalendar(fields: CronFields): string {
  const dayOfWeekPart = renderDayOfWeekField(fields.dayOfWeek);
  const datePart = `*-${renderNumericField(fields.month)}-${renderNumericField(fields.dayOfMonth)}`;
  const timePart = `${renderNumericField(fields.hour)}:${renderNumericField(fields.minute)}:00`;
  return dayOfWeekPart === undefined ? `${datePart} ${timePart}` : `${dayOfWeekPart} ${datePart} ${timePart}`;
}

// The systemd user manager's default PATH excludes `~/.local/bin` and mise's
// shims, exactly as launchd's does — see `launchd.ts`'s `composeLaunchdPath`.
// Without this, a tool `pi` shells out to resolves differently on Linux than
// macOS and the same schedule quietly behaves differently per platform.
function composeSystemdPath(home: string): string {
  return [
    join(home, '.local', 'bin'),
    join(home, '.local', 'share', 'mise', 'shims'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ].join(':');
}

function composeServiceFile(context: TimerContext): string {
  const description = escapeSystemdValue(context.schedule.name);
  const workingDirectory = escapeSystemdValue(context.schedule.cwd);
  const cradleBin = escapeSystemdValue(context.cradleBin);
  const agentDir = escapeSystemdValue(context.agentDir);
  const slug = escapeSystemdValue(context.schedule.slug);
  const logPath = escapeSystemdValue(context.logPath);
  return [
    '[Unit]',
    `Description=${description}`,
    '',
    '[Service]',
    'Type=oneshot',
    `WorkingDirectory=${workingDirectory}`,
    `Environment=PATH=${escapeSystemdValue(composeSystemdPath(context.home))}`,
    `ExecStart=${[cradleBin, 'schedule', 'run', agentDir, slug].map(quoteExecArg).join(' ')}`,
    `StandardOutput=append:${logPath}`,
    `StandardError=append:${logPath}`,
    ''
  ].join('\n');
}

function composeTimerFile(context: TimerContext, fields: CronFields): string {
  const description = escapeSystemdValue(context.schedule.name);
  const onCalendar = composeOnCalendar(fields);
  return [
    '[Unit]',
    `Description=${description}`,
    '',
    '[Timer]',
    `OnCalendar=${onCalendar}`,
    // systemd's equivalent of launchd's wake catch-up: a fire missed while
    // the session was down (asleep, logged out, rebooting) runs once on the
    // next start instead of being silently dropped.
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    ''
  ].join('\n');
}

/**
 * Compose the `.service`/`.timer` unit pair plus their `systemctl --user`
 * install/remove steps. `dayOfMonth`/`dayOfWeek` are never both
 * constrained (`parseCron` rejects that combination), so `OnCalendar=`
 * below never needs to reproduce cron's OR semantics between them.
 */
export function composeSystemdTimer(context: TimerContext, fields: CronFields): TimerPlan {
  const base = `cradle-${context.agentId}-${context.schedule.slug}`;
  const unitDir = join(context.home, '.config', 'systemd', 'user');
  const servicePath = join(unitDir, `${base}.service`);
  const timerPath = join(unitDir, `${base}.timer`);
  const timerUnit = `${base}.timer`;

  return {
    id: base,
    files: [
      { path: servicePath, content: composeServiceFile(context) },
      { path: timerPath, content: composeTimerFile(context, fields) }
    ],
    installSteps: [
      { argv: ['systemctl', '--user', 'daemon-reload'] },
      { argv: ['systemctl', '--user', 'enable', '--now', timerUnit] }
    ],
    removeSteps: [
      // Nothing may be enabled yet on a fresh remove attempt — a disable
      // against an absent timer is expected to fail, not a real error.
      { argv: ['systemctl', '--user', 'disable', '--now', timerUnit], ignoreFailure: true },
      { argv: ['systemctl', '--user', 'daemon-reload'] }
    ]
  };
}

/** `loginctl show-user <user> --property=Linger` — user timers do not fire without a session unless lingering is on. */
export function composeLingerCheckArgv(user: string): readonly string[] {
  return ['loginctl', 'show-user', user, '--property=Linger'];
}

/** One-line hint for the command layer to surface when lingering is off. */
export const LINGER_HINT =
  'systemd user timers stop firing once you log out unless lingering is enabled — run `loginctl enable-linger <user>` to keep them running';
