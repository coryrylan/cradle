// Resolves a `cradle run <ref>` reference into an agent folder path before
// `folder.ts` loads it. A bare name (no path separators, not dot/tilde-led)
// is looked up in the global alias table at `<home>/.cradle/settings.json`;
// anything path-shaped (`./x`, `../x`, `/abs`, `~/x`, `.`) is never an alias
// lookup, so a cwd-relative agent folder can never be shadowed by accident.
//
// This table is deliberately NOT keyed off `CRADLE_STATE_DIR` (`../agent/state.ts`):
// config and state have different lifetimes, so redirecting where session
// history lives must never silently move where aliases are read from.

import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { expandHome } from '../nono/profiles.js';
import { readTextIfExists } from '../setup/install.js';
import {
  hasErrorCode,
  isPathShaped,
  isRecord,
  parseJson,
  warnUnsupportedKeys,
  type JsonValue
} from '../setup/utils.js';

export interface ResolveRefDeps {
  readonly home: string;
  readonly cwd: string;
}

const BARE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Resolve a `cradle run` ref into a folder path `loadAgentFolder` can load.
 * Path-shaped refs pass through untouched (`loadAgentFolder`'s own `resolve()`
 * handles them, and they never consult `deps.cwd`); a bare name resolves
 * against the global alias table into an ABSOLUTE, normalized path, falling
 * back to the cwd-relative folder when no alias matches (so `cradle run
 * hello` from `examples/` keeps working) — and throwing only when neither
 * resolves. Every bare-name branch resolves against the injected `deps.cwd`,
 * never `process.cwd()`, so the dep is the single source of truth for what the
 * lookup tested.
 */
export async function resolveAgentRef(
  ref: string,
  deps: ResolveRefDeps
): Promise<{ dir: string; warnings: readonly string[] }> {
  if (!isAliasName(ref)) return { dir: ref, warnings: [] };

  const settingsPath = join(deps.home, '.cradle', 'settings.json');
  const warnings: string[] = [];
  const aliases = await loadAgentAliases(settingsPath, warnings);
  const localDir = join(deps.cwd, ref);
  const aliasPath = aliases.get(ref);

  if (aliasPath !== undefined) {
    const dir = resolve(expandHome(aliasPath, deps.home));
    if (await isDirectory(localDir)) warnings.push(shadowWarning(ref, dir));
    return { dir, warnings };
  }
  if (await isDirectory(localDir)) return { dir: localDir, warnings };
  throw new Error(bothMissedMessage(ref, localDir, settingsPath, aliases));
}

function isAliasName(ref: string): boolean {
  return BARE_NAME.test(ref);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) return false;
    throw error;
  }
}

/**
 * Parse the global alias table. A missing file means no aliases are
 * configured — not a warning, since most machines never create one.
 * Malformed JSON is a hard error (like every other cradle-parsed config);
 * everything else is warn-and-drop, since cradle is this file's schema
 * authority (unlike an agent folder's settings.json, which is pi-native).
 */
async function loadAgentAliases(settingsPath: string, warnings: string[]): Promise<Map<string, string>> {
  const text = await readTextIfExists(settingsPath);
  if (text === undefined) return new Map();
  const json = parseJson(text, settingsPath);
  if (!isRecord(json)) {
    warnings.push(`${settingsPath}: settings must be a JSON object — ignored`);
    return new Map();
  }
  warnUnsupportedKeys(json, settingsPath, ['agents'], warnings);
  return readAgentsMap(json, settingsPath, warnings);
}

function readAgentsMap(
  record: { readonly [key: string]: JsonValue },
  settingsPath: string,
  warnings: string[]
): Map<string, string> {
  const value = record['agents'];
  if (value === undefined) return new Map();
  if (!isRecord(value)) {
    warnings.push(`${settingsPath}: agents must be an object — ignored`);
    return new Map();
  }
  const entries = Object.entries(value)
    .map((pair): [string, string] | undefined => {
      const [name, entry] = pair;
      const path = readAgentPath(entry, name, settingsPath, warnings);
      return path === undefined ? undefined : [name, path];
    })
    .filter((entry): entry is [string, string] => entry !== undefined);
  return new Map(entries);
}

function readAgentPath(entry: JsonValue, name: string, settingsPath: string, warnings: string[]): string | undefined {
  if (!isRecord(entry)) {
    warnings.push(`${settingsPath}: agents.${name} must be an object with a "path" — ignored`);
    return undefined;
  }
  const value = entry['path'];
  if (typeof value !== 'string' || value.trim() === '') {
    warnings.push(`${settingsPath}: agents.${name}.path must be a non-empty string — ignored`);
    return undefined;
  }
  // An alias path becomes a nono `read` grant, hence the shape guard.
  if (!isPathShaped(value)) {
    warnings.push(`${settingsPath}: agents.${name}.path must be an absolute, ~/, or $HOME/ path — ignored: ${value}`);
    return undefined;
  }
  return value;
}

/** Alias resolves, but a same-named directory also exists in cwd — the alias wins; point at the escape hatch. */
function shadowWarning(ref: string, dir: string): string {
  return `started alias "${ref}" (${dir}) — a directory named ${ref} exists in the current directory; use ./${ref} to run it instead`;
}

/** Neither an alias nor a cwd-relative directory resolved — the one case this module throws. */
function bothMissedMessage(ref: string, localDir: string, settingsPath: string, aliases: Map<string, string>): string {
  const known = aliases.size > 0 ? ` (known agents: ${[...aliases.keys()].join(', ')})` : '';
  return `Agent folder not found: ${localDir} — and no "agents.${ref}" entry in ${settingsPath}${known}`;
}
