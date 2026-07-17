// Small platform-independent helpers shared across the CLI. Kept side-effect
// free so they can be unit-tested in-process.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJson(text: string, path: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${getErrorMessage(error)}`, { cause: error });
  }
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

export function quoteCommandPart(part: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(part)) {
    return part;
  }
  return `'${part.replaceAll("'", "'\\''")}'`;
}

/** Shared JSON string-array shape guard for folder/settings list readers. */
export function isStringArray(value: JsonValue): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/**
 * Only absolute (POSIX, Windows drive-letter, or UNC), `~/`, or `$HOME/`
 * prefixed entries are trusted where a string becomes a nono grant/argv
 * value — the shared flag-smuggling shape guard. The Windows shapes matter
 * because `cradle-windows-x64.exe` is a shipped target: without them every
 * drive-letter alias or grant is warned and dropped.
 */
export function isPathShaped(value: string): boolean {
  return /^(?:\/|~(?:\/|$)|\$HOME(?:\/|$)|[A-Za-z]:[\\/]|\\\\)/.test(value);
}

/** Warn once, naming every key in `record` not present in `supported`. */
export function warnUnsupportedKeys(
  record: { readonly [key: string]: JsonValue },
  path: string,
  supported: readonly string[],
  warnings: string[]
): void {
  const unsupported = Object.keys(record).filter(key => !supported.includes(key));
  if (unsupported.length > 0) {
    warnings.push(`${path}: unsupported keys ignored: ${unsupported.join(', ')}`);
  }
}
