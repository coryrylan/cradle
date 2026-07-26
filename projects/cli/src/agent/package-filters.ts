// pi's package-resource pattern vocabulary, mirrored for the one resource
// type cradle delivers (extensions — see `./packages.ts`). Both a package
// manifest's own `pi.extensions` array and settings.json's object-form
// `{ "source": …, "extensions": [...] }` filter use it: a plain entry includes
// by glob, `!` excludes by glob, `+` force-includes an exact path, `-`
// force-excludes an exact path — every path relative to the package root.
// https://pi.dev/docs/latest/packages#package-filtering

import { basename, relative, sep } from 'node:path';

/** `!`/`+`/`-` prefixed entries decide what loads; everything else names a source path or glob. */
export function isOverridePattern(pattern: string): boolean {
  return pattern.startsWith('!') || pattern.startsWith('+') || pattern.startsWith('-');
}

/**
 * Narrow `files` to what `patterns` selects, preserving input order: plain
 * globs include (none listed includes everything), `!` globs then exclude,
 * `+`/`-` exact paths force a file back in or out — force-exclude wins.
 */
export function applyPatterns(files: readonly string[], patterns: readonly string[], baseDir: string): string[] {
  const includes = patterns.filter(pattern => !isOverridePattern(pattern));
  const excludes = stripPrefix(patterns, '!');
  const forceIncludes = stripPrefix(patterns, '+');
  const forceExcludes = stripPrefix(patterns, '-');
  return files.filter(file => {
    if (matchesExact(file, forceExcludes, baseDir)) return false;
    if (matchesExact(file, forceIncludes, baseDir)) return true;
    if (matchesGlob(file, excludes, baseDir)) return false;
    return includes.length === 0 || matchesGlob(file, includes, baseDir);
  });
}

/**
 * pi's `autoload: false` delta: nothing loads except what a pattern names, and
 * for a file matched by several patterns the last one decides.
 */
export function applyDeltaPatterns(files: readonly string[], patterns: readonly string[], baseDir: string): string[] {
  return files.filter(file => {
    const decisive = patterns.filter(pattern => matchesPattern(file, pattern, baseDir)).at(-1);
    return decisive !== undefined && !decisive.startsWith('-') && !decisive.startsWith('!');
  });
}

function matchesPattern(file: string, pattern: string, baseDir: string): boolean {
  const target = isOverridePattern(pattern) ? pattern.slice(1) : pattern;
  const isExact = pattern.startsWith('+') || pattern.startsWith('-');
  return isExact ? matchesExact(file, [target], baseDir) : matchesGlob(file, [target], baseDir);
}

function stripPrefix(patterns: readonly string[], prefix: string): string[] {
  return patterns.filter(pattern => pattern.startsWith(prefix)).map(pattern => pattern.slice(1));
}

/** A glob matches a file's package-relative path, its bare filename, or its absolute path. */
function matchesGlob(file: string, patterns: readonly string[], baseDir: string): boolean {
  const candidates = [toPosix(relative(baseDir, file)), basename(file), toPosix(file)];
  return patterns.some(pattern => {
    const glob = new Bun.Glob(toPosix(pattern));
    return candidates.some(candidate => glob.match(candidate));
  });
}

/** `+`/`-` name an exact package-relative (or absolute) path — never a glob. */
function matchesExact(file: string, patterns: readonly string[], baseDir: string): boolean {
  const relativePath = toPosix(relative(baseDir, file));
  const absolutePath = toPosix(file);
  return patterns.some(pattern => {
    const normalized = toPosix(pattern.startsWith('./') ? pattern.slice(2) : pattern);
    return normalized === relativePath || normalized === absolutePath;
  });
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}
