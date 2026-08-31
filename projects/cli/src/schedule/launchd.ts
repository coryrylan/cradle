// Composes the launchd LaunchAgent artifact for a scheduled agent run — the
// macOS half of the shared TimerPlan contract in `./timer.js`. Pure
// composition, like `sbx/compose.ts` and `nono/profiles.ts`: no filesystem
// writes, no `launchctl` spawning — that's the command layer's job.

import { join } from 'node:path';

import type { CronField, CronFields } from './cron.js';
import type { TimerContext, TimerPlan } from './timer.js';

// A pathological cron expression (e.g. two near-full fields) expands to a
// combinatorial number of StartCalendarInterval dicts; capping the product
// keeps a bad schedule file from writing a multi-megabyte plist.
const MAX_CALENDAR_INTERVALS = 500;

/** Thrown when a cron expression's constrained fields would expand past `MAX_CALENDAR_INTERVALS` dicts. */
export class LaunchdIntervalOverflowError extends Error {
  constructor(dictCount: number) {
    super(
      `cron expression expands to ${String(dictCount)} StartCalendarInterval dicts, over the ` +
        `${String(MAX_CALENDAR_INTERVALS)}-dict cap`
    );
    this.name = 'LaunchdIntervalOverflowError';
  }
}

// launchd loads no shell profile, so an inherited PATH cannot be assumed —
// every directory a scheduled run might need pi/mise/homebrew tools from is
// listed explicitly.
function composeLaunchdPath(home: string): string {
  return [
    join(home, '.local', 'bin'),
    join(home, '.local', 'share', 'mise', 'shims'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ].join(':');
}

interface ConstrainedCalendarField {
  readonly key: string;
  readonly values: readonly number[];
}

type CalendarDict = { readonly [key: string]: number };

/** launchd's `StartCalendarInterval` key names, in cron field order (minute, hour, day-of-month, month, day-of-week). */
function constrainedCalendarFields(fields: CronFields): readonly ConstrainedCalendarField[] {
  const candidates: readonly { readonly key: string; readonly field: CronField }[] = [
    { key: 'Minute', field: fields.minute },
    { key: 'Hour', field: fields.hour },
    { key: 'Day', field: fields.dayOfMonth },
    { key: 'Month', field: fields.month },
    { key: 'Weekday', field: fields.dayOfWeek }
  ];
  return candidates
    .filter((candidate): candidate is { key: string; field: readonly number[] } => candidate.field !== null)
    .map(candidate => ({ key: candidate.key, values: candidate.field }));
}

/**
 * The cartesian product of every constrained field, one dict per combination.
 * An omitted key means "every" in launchd's own semantics, so an unconstrained
 * field contributes nothing to the product; all-fields-unconstrained (`* * *
 * * *`) yields the single empty dict `[{}]`.
 */
function expandCalendarDicts(fields: CronFields): readonly CalendarDict[] {
  const constrained = constrainedCalendarFields(fields);
  // `* * * * *` constrains nothing, and the cartesian product of no fields is
  // one EMPTY dict — a keyless StartCalendarInterval entry, which is not
  // launchd's documented wildcard form and may simply never fire. Spell the
  // minutes out instead, so "every minute" is stated rather than implied.
  if (constrained.length === 0) {
    return Array.from({ length: 60 }, (_unused, minute) => ({ Minute: minute }));
  }
  const dicts = constrained.reduce<readonly CalendarDict[]>(
    (accumulated, field) => accumulated.flatMap(dict => field.values.map(value => ({ ...dict, [field.key]: value }))),
    [{}]
  );
  if (dicts.length > MAX_CALENDAR_INTERVALS) throw new LaunchdIntervalOverflowError(dicts.length);
  return dicts;
}

// `&` must escape first — escaping `<`/`>` first would double-escape the
// `&` those replacements introduce.
function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlString(value: string): string {
  return `<string>${escapeXml(value)}</string>`;
}

function xmlStringArray(values: readonly string[], indent: string): string {
  const items = values.map(value => `${indent}  ${xmlString(value)}`).join('\n');
  return `${indent}<array>\n${items}\n${indent}</array>`;
}

function xmlCalendarDict(dict: CalendarDict, indent: string): string {
  const entries = Object.entries(dict)
    .map(([key, value]) => `${indent}  <key>${key}</key>\n${indent}  <integer>${String(value)}</integer>`)
    .join('\n');
  return `${indent}<dict>\n${entries}\n${indent}</dict>`;
}

function xmlCalendarIntervalArray(dicts: readonly CalendarDict[], indent: string): string {
  const items = dicts.map(dict => xmlCalendarDict(dict, `${indent}  `)).join('\n');
  return `${indent}<array>\n${items}\n${indent}</array>`;
}

function composeLaunchdPlist(context: TimerContext, label: string, dicts: readonly CalendarDict[]): string {
  const { schedule, cradleBin, agentDir, logPath, home } = context;
  const programArguments = [cradleBin, 'schedule', 'run', agentDir, schedule.slug];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>ProgramArguments</key>',
    xmlStringArray(programArguments, '  '),
    '  <key>WorkingDirectory</key>',
    `  ${xmlString(schedule.cwd)}`,
    '  <key>StartCalendarInterval</key>',
    xmlCalendarIntervalArray(dicts, '  '),
    '  <key>StandardOutPath</key>',
    `  ${xmlString(logPath)}`,
    '  <key>StandardErrorPath</key>',
    `  ${xmlString(logPath)}`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    `    ${xmlString(composeLaunchdPath(home))}`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>Label</key>',
    `  ${xmlString(label)}`,
    '</dict>',
    '</plist>',
    ''
  ].join('\n');
}

function guiDomain(uid: number): string {
  return `gui/${String(uid)}`;
}

/**
 * Compose the LaunchAgent plist plus its `launchctl` install/remove steps. `dayOfMonth`/`dayOfWeek` are never both constrained (`parseCron`
 * rejects that combination), so the cartesian product below never needs to
 * reproduce cron's OR semantics between them.
 */
export function composeLaunchdTimer(context: TimerContext, fields: CronFields): TimerPlan {
  const label = `com.cradle.${context.agentId}.${context.schedule.slug}`;
  const plistPath = join(context.home, 'Library', 'LaunchAgents', `${label}.plist`);
  const dicts = expandCalendarDicts(fields);
  const content = composeLaunchdPlist(context, label, dicts);
  const domain = guiDomain(context.uid);
  const domainTarget = `${domain}/${label}`;

  return {
    id: label,
    files: [{ path: plistPath, content }],
    installSteps: [
      // Nothing may be loaded yet on a first install — a bootout against an
      // absent service is expected to fail, not a real error.
      { argv: ['launchctl', 'bootout', domainTarget], ignoreFailure: true },
      { argv: ['launchctl', 'bootstrap', domain, plistPath] },
      { argv: ['launchctl', 'enable', domainTarget] }
    ],
    removeSteps: [{ argv: ['launchctl', 'bootout', domainTarget], ignoreFailure: true }]
  };
}
