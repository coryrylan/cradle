// Cron expression parsing and next-fire computation for scheduled agent
// runs. This module owns cron syntax and semantics so the two OS timer
// backends that consume its output — the launchd emitter
// (StartCalendarInterval) and the systemd emitter (OnCalendar=) — never
// parse cron themselves and can never disagree about what an expression
// means.

/** A parsed cron field: the allowed values, or `null` meaning "every". */
export type CronField = readonly number[] | null;

export interface CronFields {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  /** The top of the field's canonical range, used to detect "every" — usually `max`, except day-of-week (see below). */
  readonly canonicalMax: number;
  readonly names?: { readonly [key: string]: number };
  readonly normalize?: (value: number) => number;
}

const MONTH_NAMES: { readonly [key: string]: number } = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
};

const DAY_NAMES: { readonly [key: string]: number } = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// Day-of-week accepts 0-7 on input (both 0 and 7 mean Sunday), but the
// CronFields contract normalizes to 0-6 to match Date#getDay() directly.
function normalizeDayOfWeek(value: number): number {
  return value === 7 ? 0 : value;
}

const MINUTE_SPEC: FieldSpec = { name: 'minute', min: 0, max: 59, canonicalMax: 59 };
const HOUR_SPEC: FieldSpec = { name: 'hour', min: 0, max: 23, canonicalMax: 23 };
const DAY_OF_MONTH_SPEC: FieldSpec = { name: 'day-of-month', min: 1, max: 31, canonicalMax: 31 };
const MONTH_SPEC: FieldSpec = { name: 'month', min: 1, max: 12, canonicalMax: 12, names: MONTH_NAMES };
const DAY_OF_WEEK_SPEC: FieldSpec = {
  name: 'day-of-week',
  min: 0,
  max: 7,
  canonicalMax: 6,
  names: DAY_NAMES,
  normalize: normalizeDayOfWeek
};

const MACROS: { readonly [key: string]: string } = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *'
};

function cronError(expression: string, message: string): Error {
  return new Error(`Invalid cron expression "${expression}": ${message}`);
}

function expandMacro(expression: string): string {
  const trimmed = expression.trim();
  if (!trimmed.startsWith('@')) return trimmed;
  const expanded = MACROS[trimmed.toLowerCase()];
  if (expanded === undefined) throw cronError(expression, `unknown macro "${trimmed}"`);
  return expanded;
}

const FIELD_SPECS: readonly FieldSpec[] = [MINUTE_SPEC, HOUR_SPEC, DAY_OF_MONTH_SPEC, MONTH_SPEC, DAY_OF_WEEK_SPEC];

function splitFields(expanded: string, expression: string): readonly string[] {
  const tokens = expanded.split(/\s+/).filter(token => token.length > 0);
  if (tokens.length !== FIELD_SPECS.length) {
    throw cronError(
      expression,
      `expected ${String(FIELD_SPECS.length)} space-separated fields, got ${String(tokens.length)}`
    );
  }
  return tokens;
}

function rangeArray(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_unused, index) => start + index);
}

function parseValue(token: string, spec: FieldSpec, expression: string): number {
  const named = spec.names?.[token.toLowerCase()];
  const value = named ?? (/^\d+$/.test(token) ? Number(token) : Number.NaN);
  if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
    throw cronError(
      expression,
      `${spec.name} field: token "${token}" is out of range (${String(spec.min)}-${String(spec.max)})`
    );
  }
  return value;
}

function parseBaseValues(basePart: string, spec: FieldSpec, expression: string): number[] {
  if (basePart === '*') return rangeArray(spec.min, spec.max);
  const bounds = basePart.split('-');
  if (bounds.length === 1) return [parseValue(basePart, spec, expression)];
  if (bounds.length !== 2) {
    throw cronError(expression, `${spec.name} field: could not parse token "${basePart}"`);
  }
  const [startToken, endToken] = bounds;
  const start = parseValue(startToken ?? '', spec, expression);
  const end = parseValue(endToken ?? '', spec, expression);
  if (start > end) {
    throw cronError(expression, `${spec.name} field: reversed range "${basePart}" (start greater than end)`);
  }
  return rangeArray(start, end);
}

function parseStep(stepToken: string | undefined, spec: FieldSpec, expression: string): number {
  if (stepToken === undefined) return 1;
  // Digits only, matching `parseValue`: bare `Number()` would silently accept
  // `0x10`, `1e2`, and `+3` as steps, none of which are cron syntax.
  const step = /^\d+$/.test(stepToken) ? Number(stepToken) : Number.NaN;
  if (!Number.isInteger(step) || step < 1) {
    throw cronError(expression, `${spec.name} field: step must be a positive integer, got "${stepToken}"`);
  }
  return step;
}

function expandTerm(term: string, spec: FieldSpec, expression: string): number[] {
  const parts = term.split('/');
  if (parts.length > 2) {
    throw cronError(expression, `${spec.name} field: could not parse token "${term}"`);
  }
  const [basePart, stepPart] = parts;
  if (stepPart !== undefined && basePart !== '*' && !basePart?.includes('-')) {
    throw cronError(expression, `${spec.name} field: a step is only valid with "*" or a range, not "${term}"`);
  }
  const base = parseBaseValues(basePart ?? '', spec, expression);
  const step = parseStep(stepPart, spec, expression);
  return base.filter((_unused, index) => index % step === 0);
}

// A field that enumerates its entire canonical range is, semantically,
// "every" — both the launchd and systemd emitters treat an unconstrained
// field specially, so normalizing here keeps that decision in one place.
function finalizeField(values: readonly number[], spec: FieldSpec): CronField {
  const normalized = spec.normalize ? values.map(spec.normalize) : values;
  const unique = Array.from(new Set(normalized)).sort((left, right) => left - right);
  const fullRangeSize = spec.canonicalMax - spec.min + 1;
  return unique.length === fullRangeSize ? null : unique;
}

function parseField(token: string, spec: FieldSpec, expression: string): CronField {
  if (token.length === 0) {
    throw cronError(expression, `${spec.name} field: empty token`);
  }
  const values = token.split(',').flatMap(term => expandTerm(term, spec, expression));
  return finalizeField(values, spec);
}

/**
 * Parse a 5-field cron expression or a `@`-macro into structured fields.
 * Throws a named error when the expression is malformed, or when
 * day-of-month and day-of-week are both restricted (see the check below).
 */
export function parseCron(expression: string): CronFields {
  const tokens = splitFields(expandMacro(expression), expression);
  const field = (index: number, spec: FieldSpec): CronField => parseField(tokens[index] ?? '', spec, expression);

  const dayOfMonth = field(2, DAY_OF_MONTH_SPEC);
  const dayOfWeek = field(4, DAY_OF_WEEK_SPEC);

  if (dayOfMonth !== null && dayOfWeek !== null) {
    // Cron ORs day-of-month and day-of-week ("the 1st, AND every Monday"),
    // but launchd's StartCalendarInterval array and systemd's OnCalendar=
    // both AND every field they're given — neither can express that OR.
    // Rejecting the combination here, once, is the only way both emitters
    // are guaranteed to agree instead of each guessing independently.
    throw cronError(
      expression,
      'day-of-month and day-of-week cannot both be restricted (cron ORs them; launchd/systemd AND them, so there is no faithful encoding)'
    );
  }

  return {
    minute: field(0, MINUTE_SPEC),
    hour: field(1, HOUR_SPEC),
    dayOfMonth,
    month: field(3, MONTH_SPEC),
    dayOfWeek
  };
}

function includesOrEvery(field: CronField, value: number): boolean {
  return field === null || field.includes(value);
}

function matchesDate(fields: CronFields, date: Date): boolean {
  // day-of-month and day-of-week are never both constrained here — parseCron
  // rejects that combination — so matching the date fields is a plain AND,
  // with no cron OR semantics left to reproduce.
  return (
    includesOrEvery(fields.month, date.getMonth() + 1) &&
    includesOrEvery(fields.dayOfMonth, date.getDate()) &&
    includesOrEvery(fields.dayOfWeek, date.getDay())
  );
}

function matchesHour(fields: CronFields, date: Date): boolean {
  return includesOrEvery(fields.hour, date.getHours());
}

function matchesMinute(fields: CronFields, date: Date): boolean {
  return includesOrEvery(fields.minute, date.getMinutes());
}

// Local-component Date construction (rather than setDate/setHours mutation)
// so month/year rollover (Jan 31 -> Feb 1) and DST gaps/overlaps are resolved
// by the platform's own calendar math instead of bespoke rollover logic.
function truncateToNextMinute(from: Date): Date {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours(), from.getMinutes() + 1);
}

function startOfNextDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

function startOfNextHour(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours() + 1);
}

function startOfNextMinute(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes() + 1);
}

/**
 * The next occurrence strictly after `from`, in local time, truncated to the
 * minute. Returns `null` when nothing matches within 366 days — the guard
 * against an expression that can never fire, such as day-of-month 30 paired
 * with February.
 */
export function nextFire(fields: CronFields, from: Date): Date | null {
  const deadline = new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate() + 366,
    from.getHours(),
    from.getMinutes()
  );
  let candidate = truncateToNextMinute(from);

  while (candidate.getTime() <= deadline.getTime()) {
    if (!matchesDate(fields, candidate)) {
      candidate = startOfNextDay(candidate);
      continue;
    }
    if (!matchesHour(fields, candidate)) {
      candidate = startOfNextHour(candidate);
      continue;
    }
    if (matchesMinute(fields, candidate)) return candidate;
    candidate = startOfNextMinute(candidate);
  }
  return null;
}
