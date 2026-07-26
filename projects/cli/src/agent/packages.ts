// Resolution for settings.json's `packages` key — pi's own npm-distributed
// extension mechanism (`"packages": ["npm:pi-example-tool"]`, or pi's object
// form `{"source": "npm:pi-example-tool", "extensions": ["*.ts"]}`). Agent
// runs pass `--no-extensions`, so pi's own package loader never runs for them;
// cradle resolves the declared npm: sources itself into a per-agent npm
// project (see `commands/run.ts`'s `PackagesPlan`) and passes the package's
// selected entry files as explicit `-e` flags instead — pi loads explicit
// `-e` paths even under `--no-extensions`.

import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { readTextIfExists } from '../setup/install.js';
import { getErrorMessage, hasErrorCode, isRecord, isStringArray, parseJson, type JsonValue } from '../setup/utils.js';
import { applyDeltaPatterns, applyPatterns, isOverridePattern } from './package-filters.js';

/**
 * The object form's resource filter, narrowed to the one resource type cradle
 * delivers. Absent `extensions` loads everything the package declares, `[]`
 * loads none, patterns decide otherwise (see `./package-filters.js`).
 */
interface PackageFilter {
  readonly extensions?: readonly string[];
  /** pi's `autoload: false` — nothing loads except what an `extensions` pattern names. */
  readonly autoloadDisabled?: boolean;
}

/** A parsed `npm:<name>[@<version>]` package source from settings.json's `packages` key. */
export interface NpmPackageSpec extends PackageFilter {
  readonly name: string;
  readonly version: string;
}

/** One settings.json `packages` element, either form, before its source is parsed. */
interface PackageEntry extends PackageFilter {
  readonly source: string;
}

// A spec's `name` becomes a node_modules filesystem path segment and a `-e`
// argv value; its `version` lands verbatim in a generated package.json that
// npm interprets. Both are shape-guarded here — before anything downstream
// treats them as trusted — so a hostile folder can't smuggle a path (`../x`),
// a flag, or an alternate install source (`file:`, `git+https://`) through
// either field.
const NPM_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const NPM_PACKAGE_VERSION = /^[0-9A-Za-z.^~><=* +-]+$/;
const EXTENSION_FILE = /\.[tj]s$/;
const GLOB_PATTERN = /[*?]/;

/**
 * Parse a settings.json record's `packages` key — pi's source strings, pi's
 * filter objects, or a mix — into validated npm: package specs. Only `npm:`
 * sources are supported — pi also accepts `git:`, `https://`, `ssh://`, and
 * local paths, all warned and dropped here, since cradle installs the package
 * itself rather than delegating to pi's loader.
 */
export function readPackageSpecs(
  record: { readonly [key: string]: JsonValue },
  path: string,
  warnings: string[]
): readonly NpmPackageSpec[] {
  const value = record['packages'];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`${path}: packages must be an array — ignored`);
    return [];
  }
  const entries = readPackageEntries(value, path, warnings);
  const npmEntries = warnNonNpmSources(entries, path, warnings);
  return parseNpmEntries(npmEntries, path, warnings);
}

/** Read both of pi's `packages` element forms: a bare source string, or a filter object carrying one. */
function readPackageEntries(value: readonly JsonValue[], path: string, warnings: string[]): readonly PackageEntry[] {
  const entries: PackageEntry[] = [];
  const invalidEntries: string[] = [];
  for (const item of value) {
    const entry = typeof item === 'string' ? { source: item } : readFilterEntry(item, path, warnings);
    if (entry === null) invalidEntries.push(JSON.stringify(item));
    else entries.push(entry);
  }
  if (invalidEntries.length > 0) {
    warnings.push(
      `${path}: packages entries must be a source string or a { "source": … } object — ignored: ${invalidEntries.join(', ')}`
    );
  }
  return entries;
}

/**
 * pi's object form — `{"source": "npm:x", "extensions": ["…"], "skills": []}`.
 * Only `source`, `extensions`, and `autoload` reach an agent run: cradle
 * delivers a package's extensions as `-e` flags and nothing else, so the
 * sibling resource filters are warned and dropped.
 */
function readFilterEntry(item: JsonValue, path: string, warnings: string[]): PackageEntry | null {
  if (!isRecord(item)) return null;
  const source = item['source'];
  if (typeof source !== 'string') return null;
  warnUnusedFilterKeys(item, source, path, warnings);
  const autoload = item['autoload'];
  if (autoload !== undefined && typeof autoload !== 'boolean') {
    warnings.push(`${path}: packages entry ${source}: autoload must be a boolean — ignored`);
  }
  const extensions = readFilterPatterns(item, source, path, warnings);
  return {
    source,
    ...(extensions !== undefined ? { extensions } : {}),
    ...(autoload === false ? { autoloadDisabled: true } : {})
  };
}

function readFilterPatterns(
  item: { readonly [key: string]: JsonValue },
  source: string,
  path: string,
  warnings: string[]
): readonly string[] | undefined {
  const value = item['extensions'];
  if (value === undefined) return undefined;
  if (!isStringArray(value)) {
    warnings.push(`${path}: packages entry ${source}: extensions must be an array of strings — ignored`);
    return undefined;
  }
  return value;
}

const DELIVERED_FILTER_KEYS = new Set(['source', 'extensions', 'autoload']);
const PI_RESOURCE_FILTER_KEYS = new Set(['skills', 'prompts', 'themes']);

function warnUnusedFilterKeys(
  item: { readonly [key: string]: JsonValue },
  source: string,
  path: string,
  warnings: string[]
): void {
  const keys = Object.keys(item).filter(key => !DELIVERED_FILTER_KEYS.has(key));
  const undelivered = keys.filter(key => PI_RESOURCE_FILTER_KEYS.has(key));
  const unknown = keys.filter(key => !PI_RESOURCE_FILTER_KEYS.has(key));
  if (undelivered.length > 0) {
    warnings.push(
      `${path}: packages entry ${source}: cradle loads a package's extensions and nothing else — ignored: ${undelivered.join(', ')}`
    );
  }
  if (unknown.length > 0) {
    warnings.push(`${path}: packages entry ${source}: unknown filter keys — ignored: ${unknown.join(', ')}`);
  }
}

/** Split entries into supported `npm:` sources, warning once for the rest (`git:`, `https://`, `ssh://`, local paths). */
function warnNonNpmSources(
  entries: readonly PackageEntry[],
  path: string,
  warnings: string[]
): readonly PackageEntry[] {
  const npmEntries = entries.filter(entry => entry.source.startsWith('npm:'));
  const nonNpmEntries = entries.filter(entry => !entry.source.startsWith('npm:'));
  if (nonNpmEntries.length > 0) {
    const sources = nonNpmEntries.map(entry => entry.source).join(', ');
    warnings.push(`${path}: only npm: package sources are supported — ignored: ${sources}`);
  }
  return npmEntries;
}

/** Parse each `npm:` entry into a spec, warning once (with all offenders) for shape-invalid ones. */
function parseNpmEntries(
  npmEntries: readonly PackageEntry[],
  path: string,
  warnings: string[]
): readonly NpmPackageSpec[] {
  const specs: NpmPackageSpec[] = [];
  const invalidEntries: string[] = [];
  for (const { source, ...filter } of npmEntries) {
    const spec = parseNpmSource(source.slice('npm:'.length));
    if (spec === null) invalidEntries.push(source);
    else specs.push({ ...spec, ...filter });
  }
  if (invalidEntries.length > 0) {
    warnings.push(`${path}: packages entries must be npm:<name>[@<version>] — ignored: ${invalidEntries.join(', ')}`);
  }
  return specs;
}

/** Split `<name>[@<version>]` at the last non-leading `@` so a scope's own `@` isn't mistaken for the separator. */
function parseNpmSource(source: string): { name: string; version: string } | null {
  const atIndex = source.lastIndexOf('@');
  const hasVersion = atIndex > 0;
  const name = hasVersion ? source.slice(0, atIndex) : source;
  const version = hasVersion ? source.slice(atIndex + 1) : 'latest';
  if (!NPM_PACKAGE_NAME.test(name) || !NPM_PACKAGE_VERSION.test(version)) return null;
  return { name, version };
}

/** Deterministic npm manifest for a per-agent packages install, dependencies sorted by name. */
export function emitPackagesManifest(specs: readonly NpmPackageSpec[]): string {
  const dependencies = Object.fromEntries(
    [...specs].sort((left, right) => left.name.localeCompare(right.name)).map(spec => [spec.name, spec.version])
  );
  return `${JSON.stringify({ name: 'cradle-agent-packages', private: true, dependencies }, null, 2)}\n`;
}

/**
 * Resolve each spec's installed package into the pi extension entry files its
 * settings.json entry selects, ready to pass as explicit `-e` flags. Every
 * failure (not installed, malformed manifest, an entry that escapes the
 * package directory, a missing entry file, no declared extensions) is a
 * warning + skip — packages are warn-don't-throw like every other
 * agent-folder input. A filter selecting nothing is silent: that is the
 * author asking for nothing, not a failure.
 */
export async function resolvePackageEntries(
  npmDir: string,
  specs: readonly NpmPackageSpec[]
): Promise<{ entries: string[]; warnings: string[] }> {
  const perSpec = await Promise.all(
    specs.map(async spec => {
      const localWarnings: string[] = [];
      const entries = await resolvePackageEntry(npmDir, spec, localWarnings);
      return { entries, warnings: localWarnings };
    })
  );
  return {
    entries: perSpec.flatMap(result => result.entries),
    warnings: perSpec.flatMap(result => result.warnings)
  };
}

async function resolvePackageEntry(npmDir: string, spec: NpmPackageSpec, warnings: string[]): Promise<string[]> {
  const packageDir = join(npmDir, 'node_modules', spec.name);
  const manifest = await readPackageManifest(spec.name, packageDir, warnings);
  if (manifest === null) return [];
  const declared = await collectExtensionFiles(packageDir, manifest, spec.name, warnings);
  return selectFilteredEntries(declared, spec, packageDir);
}

async function readPackageManifest(
  name: string,
  packageDir: string,
  warnings: string[]
): Promise<{ readonly [key: string]: JsonValue } | null> {
  const manifestPath = join(packageDir, 'package.json');
  const text = await readTextIfExists(manifestPath);
  if (text === undefined) {
    warnings.push(`package ${name} is not installed — skipped`);
    return null;
  }
  try {
    const manifest = parseJson(text, manifestPath);
    if (!isRecord(manifest)) {
      warnings.push(`package ${name}: ${manifestPath} must be a JSON object — skipped`);
      return null;
    }
    return manifest;
  } catch (error) {
    warnings.push(`package ${name}: ${getErrorMessage(error)} — skipped`);
    return null;
  }
}

/**
 * Every extension file the package offers, before the settings.json filter
 * narrows it — pi's own discovery order: the manifest's declared
 * `pi.extensions` entries, else the convention `extensions/` directory, else a
 * top-level `index.ts`/`index.js`.
 */
async function collectExtensionFiles(
  packageDir: string,
  manifest: { readonly [key: string]: JsonValue },
  name: string,
  warnings: string[]
): Promise<string[]> {
  const declared = readDeclaredExtensions(manifest);
  if (declared !== undefined) return resolveDeclaredExtensions(packageDir, declared, name, warnings);
  const convention = await collectExtensionDir(join(packageDir, 'extensions'));
  if (convention.length > 0) return convention;
  return resolveFallbackEntry(name, packageDir, warnings);
}

/**
 * pi's declared-extensions shape: `package.json`'s `pi.extensions` array of
 * paths, globs, and `!`/`+`/`-` overrides. Undefined when absent, empty, or
 * malformed — all three fall through to discovery, as they do in pi.
 */
function readDeclaredExtensions(manifest: { readonly [key: string]: JsonValue }): readonly string[] | undefined {
  const pi = manifest['pi'];
  if (pi === undefined || !isRecord(pi)) return undefined;
  const extensions = pi['extensions'];
  if (extensions === undefined || !isStringArray(extensions) || extensions.length === 0) return undefined;
  return extensions;
}

/** Expand the manifest's source entries into files, then let its own `!`/`+`/`-` overrides narrow them. */
async function resolveDeclaredExtensions(
  packageDir: string,
  declared: readonly string[],
  name: string,
  warnings: string[]
): Promise<string[]> {
  const sources = declared.filter(entry => !isOverridePattern(entry));
  const expanded = await Promise.all(sources.map(entry => expandDeclaredEntry(packageDir, entry, name, warnings)));
  const files = expanded.flat();
  const overrides = declared.filter(isOverridePattern);
  return overrides.length > 0 ? applyPatterns(files, overrides, packageDir) : files;
}

/** A manifest entry names a file, a directory of extensions, or — with `*`/`?` — a glob of either. */
async function expandDeclaredEntry(
  packageDir: string,
  entry: string,
  name: string,
  warnings: string[]
): Promise<string[]> {
  const candidates = await resolveEntryPaths(packageDir, entry);
  const inside = candidates.filter(candidate => isInsidePackage(packageDir, candidate));
  if (inside.length < candidates.length) {
    warnings.push(`package ${name}: extension entry "${entry}" escapes the package directory — skipped`);
  }
  const expanded = await Promise.all(inside.map(async path => ({ files: await expandPath(path) })));
  if (expanded.some(result => result.files === null)) {
    warnings.push(`package ${name}: extension entry "${entry}" not found — skipped`);
  }
  return expanded.flatMap(result => result.files ?? []);
}

async function resolveEntryPaths(packageDir: string, entry: string): Promise<readonly string[]> {
  if (!GLOB_PATTERN.test(entry)) return [resolve(packageDir, entry)];
  const matches = new Bun.Glob(entry).scan({ cwd: packageDir, absolute: true, onlyFiles: false });
  return (await Array.fromAsync(matches)).map(match => resolve(match)).sort();
}

/** Null when the path does not exist — a directory expands to the extension files it holds. */
async function expandPath(path: string): Promise<string[] | null> {
  const info = await statIfExists(path);
  if (info === undefined) return null;
  return info.isDirectory() ? collectExtensionDir(path) : [path];
}

/** pi's discovery shape for a directory of extensions: top-level `*.ts`/`*.js` plus each subdirectory's `index.ts`/`index.js`. */
async function collectExtensionDir(dir: string): Promise<string[]> {
  const entries = await readDirIfExists(dir);
  const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  const resolved = await Promise.all(sorted.map(entry => resolveDirEntry(dir, entry)));
  return resolved.flat();
}

async function resolveDirEntry(dir: string, entry: Dirent): Promise<string[]> {
  if (entry.name.startsWith('.') || entry.name === 'node_modules') return [];
  if (entry.isFile()) return EXTENSION_FILE.test(entry.name) ? [join(dir, entry.name)] : [];
  if (!entry.isDirectory()) return [];
  const index = await firstExisting([join(dir, entry.name, 'index.ts'), join(dir, entry.name, 'index.js')]);
  return index === null ? [] : [index];
}

/** pi's discovery fallback for a package with no declared `pi.extensions` and no `extensions/` directory. */
async function resolveFallbackEntry(name: string, packageDir: string, warnings: string[]): Promise<string[]> {
  const fallback = await firstExisting([join(packageDir, 'index.ts'), join(packageDir, 'index.js')]);
  if (fallback === null) {
    warnings.push(`package ${name} declares no pi extensions — skipped`);
    return [];
  }
  return [fallback];
}

/** Apply the settings.json entry's filter: absent loads everything declared, `[]` loads none, patterns decide otherwise. */
function selectFilteredEntries(files: readonly string[], spec: NpmPackageSpec, packageDir: string): string[] {
  if (spec.autoloadDisabled === true) return applyDeltaPatterns(files, spec.extensions ?? [], packageDir);
  if (spec.extensions === undefined) return [...files];
  if (spec.extensions.length === 0) return [];
  return applyPatterns(files, spec.extensions, packageDir);
}

function isInsidePackage(packageDir: string, path: string): boolean {
  const packageDirWithSep = packageDir.endsWith(sep) ? packageDir : `${packageDir}${sep}`;
  return path === packageDir || path.startsWith(packageDirWithSep);
}

async function firstExisting(paths: readonly string[]): Promise<string | null> {
  const found = await Promise.all(paths.map(async path => ((await Bun.file(path).exists()) ? path : null)));
  return found.find(path => path !== null) ?? null;
}

async function statIfExists(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) return undefined;
    throw error;
  }
}

async function readDirIfExists(dir: string): Promise<readonly Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) return [];
    throw error;
  }
}
