// Resolution for settings.json's `packages` key — pi's own npm-distributed
// extension mechanism (`"packages": ["npm:pi-example-tool"]`). Agent runs pass
// `--no-extensions`, so pi's own package loader never runs for them; cradle
// resolves the declared npm: sources itself into a per-agent npm project (see
// `commands/run.ts`'s `PackagesPlan`) and passes each installed package's
// declared entry files as explicit `-e` flags instead — pi loads explicit
// `-e` paths even under `--no-extensions`.

import { join, resolve, sep } from 'node:path';

import { readTextIfExists } from '../setup/install.js';
import { getErrorMessage, isRecord, isStringArray, parseJson, type JsonValue } from '../setup/utils.js';

/** A parsed `npm:<name>[@<version>]` package source from settings.json's `packages` key. */
export interface NpmPackageSpec {
  readonly name: string;
  readonly version: string;
}

// A spec's `name` becomes a node_modules filesystem path segment and a `-e`
// argv value; its `version` lands verbatim in a generated package.json that
// npm interprets. Both are shape-guarded here — before anything downstream
// treats them as trusted — so a hostile folder can't smuggle a path (`../x`),
// a flag, or an alternate install source (`file:`, `git+https://`) through
// either field.
const NPM_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const NPM_PACKAGE_VERSION = /^[0-9A-Za-z.^~><=* +-]+$/;

/**
 * Parse a settings.json record's `packages` key into validated npm: package
 * specs. Only `npm:` sources are supported — pi also accepts `git:`,
 * `https://`, `ssh://`, and local paths, all warned and dropped here, since
 * cradle installs the package itself rather than delegating to pi's loader.
 */
export function readPackageSpecs(
  record: { readonly [key: string]: JsonValue },
  path: string,
  warnings: string[]
): readonly NpmPackageSpec[] {
  const value = record['packages'];
  if (value === undefined) return [];
  if (!isStringArray(value)) {
    warnings.push(`${path}: packages must be an array of strings — ignored`);
    return [];
  }
  const npmEntries = warnNonNpmSources(value, path, warnings);
  return parseNpmEntries(npmEntries, path, warnings);
}

/** Split `packages` entries into supported `npm:` sources, warning once for the rest (`git:`, `https://`, `ssh://`, local paths). */
function warnNonNpmSources(entries: readonly string[], path: string, warnings: string[]): readonly string[] {
  const npmEntries = entries.filter(entry => entry.startsWith('npm:'));
  const nonNpmEntries = entries.filter(entry => !entry.startsWith('npm:'));
  if (nonNpmEntries.length > 0) {
    warnings.push(`${path}: only npm: package sources are supported — ignored: ${nonNpmEntries.join(', ')}`);
  }
  return npmEntries;
}

/** Parse each `npm:` entry into a spec, warning once (with all offenders) for shape-invalid ones. */
function parseNpmEntries(npmEntries: readonly string[], path: string, warnings: string[]): readonly NpmPackageSpec[] {
  const specs: NpmPackageSpec[] = [];
  const invalidEntries: string[] = [];
  for (const entry of npmEntries) {
    const spec = parseNpmSource(entry.slice('npm:'.length));
    if (spec === null) invalidEntries.push(entry);
    else specs.push(spec);
  }
  if (invalidEntries.length > 0) {
    warnings.push(`${path}: packages entries must be npm:<name>[@<version>] — ignored: ${invalidEntries.join(', ')}`);
  }
  return specs;
}

/** Split `<name>[@<version>]` at the last non-leading `@` so a scope's own `@` isn't mistaken for the separator. */
function parseNpmSource(source: string): NpmPackageSpec | null {
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
 * Resolve each spec's installed package into pi extension entry files, ready
 * to pass as explicit `-e` flags. Every failure (not installed, malformed
 * manifest, an entry that escapes the package directory, a missing entry
 * file, no declared extensions) is a warning + skip — packages are
 * warn-don't-throw like every other agent-folder input.
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

  const declared = readDeclaredExtensions(manifest);
  if (declared === undefined) return resolveFallbackEntry(spec.name, packageDir, warnings);

  const entries: string[] = [];
  for (const relative of declared) {
    const resolved = await resolveExtensionEntry(spec.name, packageDir, relative, warnings);
    if (resolved !== null) entries.push(resolved);
  }
  return entries;
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

/** pi's declared-extensions shape: `package.json`'s `pi.extensions` array of relative paths. Undefined when absent/malformed. */
function readDeclaredExtensions(manifest: { readonly [key: string]: JsonValue }): readonly string[] | undefined {
  const pi = manifest['pi'];
  if (pi === undefined || !isRecord(pi)) return undefined;
  const extensions = pi['extensions'];
  if (extensions === undefined || !isStringArray(extensions)) return undefined;
  return extensions;
}

/** pi's discovery fallback for a package with no declared `pi.extensions`: a top-level `index.ts`. */
async function resolveFallbackEntry(name: string, packageDir: string, warnings: string[]): Promise<string[]> {
  const fallback = join(packageDir, 'index.ts');
  if (await Bun.file(fallback).exists()) return [fallback];
  warnings.push(`package ${name} declares no pi extensions — skipped`);
  return [];
}

/** Resolve a declared extension path relative to its package dir, guarding against traversal outside it. */
async function resolveExtensionEntry(
  name: string,
  packageDir: string,
  relative: string,
  warnings: string[]
): Promise<string | null> {
  const resolved = resolve(packageDir, relative);
  const packageDirWithSep = packageDir.endsWith(sep) ? packageDir : `${packageDir}${sep}`;
  if (resolved !== packageDir && !resolved.startsWith(packageDirWithSep)) {
    warnings.push(`package ${name}: extension entry "${relative}" escapes the package directory — skipped`);
    return null;
  }
  if (!(await Bun.file(resolved).exists())) {
    warnings.push(`package ${name}: extension entry "${relative}" not found — skipped`);
    return null;
  }
  return resolved;
}
