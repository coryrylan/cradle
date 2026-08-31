// Loader for `schedule/*.md` — see /ARCHITECTURE.md. Each file is a
// scheduled pi invocation: YAML frontmatter (`cron`, `cwd`, optional `name`/
// `description`) plus a markdown body that is the prompt, verbatim. This is a
// COLLECTION of independent items, so a malformed entry warns-and-drops, the
// same precedent as packages.ts's `readPackageSpecs`, rather than failing the
// whole folder like folder.ts's single-file loading does — one broken
// schedule must not stop the others from loading. `cron` is kept as an
// opaque raw string here; `../schedule/cron.ts` owns parsing it.

import type { Dirent } from 'node:fs';
import { exists, readdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

import { expandHome } from '../nono/profiles.js';
import { readTextIfExists } from '../setup/install.js';
import { getErrorMessage, isPathShaped } from '../setup/utils.js';

export interface Schedule {
  /** Filename without `.md` — the identity used on the CLI and in timer labels. */
  readonly slug: string;
  /** Display label from frontmatter `name`; falls back to `slug`. */
  readonly name: string;
  /** Absolute path of the source `.md`. */
  readonly path: string;
  /** Raw cron expression, unparsed. */
  readonly cron: string;
  /** Absolute working directory, `~`/`$HOME` already expanded. */
  readonly cwd: string;
  readonly description?: string;
  /** The markdown body — the prompt handed to pi. */
  readonly prompt: string;
}

export interface LoadedSchedules {
  readonly schedules: readonly Schedule[];
  readonly warnings: readonly string[];
}

/** Frontmatter parsed from YAML, before any key is validated — values are untyped until read. */
type FrontmatterRecord = { readonly [key: string]: unknown };

const FRONTMATTER_KEYS: readonly string[] = ['name', 'description', 'cron', 'cwd'];

// A slug becomes a launchd label and a systemd unit name, so its shape is
// guarded the same way aliases.ts's BARE_NAME guards an alias name.
const SLUG_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The "folder has no `schedule/`" error. `schedules/` is the intuitive guess
 * for a directory holding many schedules, so when that is what the folder
 * actually has, name the rename — the same targeted hint `folder.ts` gives for
 * a legacy `AGENTS.md`.
 */
export async function missingScheduleDirError(agentDir: string): Promise<Error> {
  const hint = (await exists(join(agentDir, 'schedules')))
    ? ' — found schedules/, rename it to schedule/ (singular)'
    : '';
  return new Error(`No schedule/ directory in ${agentDir}${hint}`);
}

export async function loadSchedules(scheduleDir: string, home: string): Promise<LoadedSchedules> {
  const entries = await readdir(scheduleDir, { withFileTypes: true });
  const warnings: string[] = [];
  const results = await Promise.all(entries.map(entry => readScheduleEntry(scheduleDir, entry, home, warnings)));
  const schedules = results.filter((schedule): schedule is Schedule => schedule !== null);
  return {
    schedules: [...schedules].sort((left, right) => left.slug.localeCompare(right.slug)),
    warnings
  };
}

/** Anything in `schedule/` that isn't a `.md` file — a subdirectory or another file type — isn't a schedule at all. */
async function readScheduleEntry(
  dir: string,
  entry: Dirent,
  home: string,
  warnings: string[]
): Promise<Schedule | null> {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) {
    warnings.push(`${path}: subdirectories are not supported in schedule/ — ignored`);
    return null;
  }
  // Symlinks count as files here: the folder format tolerates a symlinked
  // `skills/`, so a schedule shared between agents by symlink must work too.
  // `readTextIfExists` follows the link; a broken one reads as absent.
  if (!entry.isFile() && !entry.isSymbolicLink()) {
    warnings.push(`${path}: only files are read from schedule/ — ignored`);
    return null;
  }
  if (extname(entry.name) !== '.md') {
    warnings.push(`${path}: only .md files are read from schedule/ — ignored`);
    return null;
  }
  return readSchedule(path, home, warnings);
}

async function readSchedule(path: string, home: string, warnings: string[]): Promise<Schedule | null> {
  const slug = basename(path, '.md');
  if (!SLUG_SHAPE.test(slug)) {
    warnings.push(
      `${path}: filename must match ${SLUG_SHAPE.source} — a schedule slug becomes a launchd label and a ` +
        `systemd unit name — ignored`
    );
    return null;
  }
  const text = await readTextIfExists(path);
  if (text === undefined) {
    // Reached by a broken symlink, which `readScheduleEntry` deliberately lets
    // through as a supported shape. Silence here would drop the schedule from
    // both `list` and `install` with nothing to explain the absence.
    warnings.push(`${path}: could not be read — broken symlink? — ignored`);
    return null;
  }
  const split = splitFrontmatter(text);
  if (split === null) {
    warnings.push(`${path}: missing YAML frontmatter block (a file starting with "---" and a closing "---") — ignored`);
    return null;
  }
  const frontmatter = parseFrontmatterYaml(split.frontmatter, path, warnings);
  if (frontmatter === null) return null;
  return buildSchedule({ slug, path, frontmatter, body: split.body, home, warnings });
}

interface FrontmatterSplit {
  readonly frontmatter: string;
  readonly body: string;
}

/**
 * Split a schedule file into its YAML frontmatter and markdown body. The file
 * must start with a `---` line; the block ends at the next line that is
 * exactly `---`. This module is the splitter's only consumer, so it stays
 * local rather than becoming a shared utility.
 */
function splitFrontmatter(text: string): FrontmatterSplit | null {
  const lines = text.split('\n').map(line => line.replace(/\r$/, ''));
  if (lines[0] !== '---') return null;
  const closingIndex = lines.indexOf('---', 1);
  if (closingIndex === -1) return null;
  return { frontmatter: lines.slice(1, closingIndex).join('\n'), body: lines.slice(closingIndex + 1).join('\n') };
}

function parseFrontmatterYaml(yaml: string, path: string, warnings: string[]): FrontmatterRecord | null {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(yaml);
  } catch (error) {
    warnings.push(`${path}: frontmatter is not valid YAML: ${getErrorMessage(error)} — ignored`);
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warnings.push(`${path}: frontmatter must be a YAML mapping — ignored`);
    return null;
  }
  return parsed as FrontmatterRecord;
}

interface BuildScheduleParams {
  readonly slug: string;
  readonly path: string;
  readonly frontmatter: FrontmatterRecord;
  readonly body: string;
  readonly home: string;
  readonly warnings: string[];
}

function buildSchedule(params: BuildScheduleParams): Schedule | null {
  const { slug, path, frontmatter, body, home, warnings } = params;
  warnUnknownFrontmatterKeys(frontmatter, path, warnings);
  const cron = readCron(frontmatter, path, warnings);
  const cwd = readCwd(frontmatter, path, home, warnings);
  const name = readOptionalStringKey(frontmatter, 'name', path, warnings);
  const description = readOptionalStringKey(frontmatter, 'description', path, warnings);
  const prompt = body.trim();
  if (cron === null || cwd === null) return null;
  if (prompt === '') {
    warnings.push(`${path}: body is empty — a schedule with no prompt does nothing — ignored`);
    return null;
  }
  return {
    slug,
    name: name ?? slug,
    path,
    cron,
    cwd,
    ...(description !== undefined ? { description } : {}),
    prompt
  };
}

/** Mirrors `warnUnsupportedKeys`'s message format — its `JsonValue`-keyed record shape doesn't fit parsed YAML's `unknown` values. */
function warnUnknownFrontmatterKeys(record: FrontmatterRecord, path: string, warnings: string[]): void {
  const unsupported = Object.keys(record).filter(key => !FRONTMATTER_KEYS.includes(key));
  if (unsupported.length > 0) {
    warnings.push(`${path}: unsupported keys ignored: ${unsupported.join(', ')}`);
  }
}

function readCron(record: FrontmatterRecord, path: string, warnings: string[]): string | null {
  const value = record['cron'];
  if (typeof value !== 'string' || value.trim() === '') {
    warnings.push(`${path}: cron must be a non-empty string — ignored`);
    return null;
  }
  // Stored raw — this module never parses cron, see the header comment.
  return value;
}

function readCwd(record: FrontmatterRecord, path: string, home: string, warnings: string[]): string | null {
  const value = record['cwd'];
  if (typeof value !== 'string' || !isPathShaped(value)) {
    warnings.push(`${path}: cwd must be an absolute, ~/, or $HOME/ path${tildeNullHint(value)} — ignored`);
    return null;
  }
  return resolve(expandHome(value, home));
}

/**
 * A bare `~` is YAML's null literal, so `cwd: ~` parses to null and trips the
 * path check with a message that names `~/` — baffling for an author who wrote
 * exactly that. Name the trap instead of leaving them to guess.
 */
function tildeNullHint(value: unknown): string {
  return value === null ? ' (a bare "~" is YAML null — quote it as "~" or write ~/some/dir)' : '';
}

function readOptionalStringKey(
  record: FrontmatterRecord,
  key: string,
  path: string,
  warnings: string[]
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    warnings.push(`${path}: ${key} must be a string — ignored`);
    return undefined;
  }
  return value;
}
