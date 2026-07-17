import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonValue } from '../setup/utils.js';
import { emitPackagesManifest, readPackageSpecs, resolvePackageEntries } from './packages.js';

function parse(packages: JsonValue | undefined): { specs: ReturnType<typeof readPackageSpecs>; warnings: string[] } {
  const warnings: string[] = [];
  const record = packages === undefined ? {} : { packages };
  const specs = readPackageSpecs(record, 'settings.json', warnings);
  return { specs, warnings };
}

describe('readPackageSpecs', () => {
  it('should return an empty array when packages is absent', () => {
    const { specs, warnings } = parse(undefined);
    expect(specs).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('should warn and drop when packages is not an array of strings', () => {
    const { specs, warnings } = parse({ nope: true });
    expect(specs).toEqual([]);
    expect(warnings).toEqual(['settings.json: packages must be an array of strings — ignored']);
  });

  it('should warn and drop when packages contains a non-string entry', () => {
    const { specs, warnings } = parse(['npm:ok', 7]);
    expect(specs).toEqual([]);
    expect(warnings).toEqual(['settings.json: packages must be an array of strings — ignored']);
  });

  it('should parse a bare npm: source with an implicit latest version', () => {
    const { specs, warnings } = parse(['npm:pi-example-tool']);
    expect(specs).toEqual([{ name: 'pi-example-tool', version: 'latest' }]);
    expect(warnings).toEqual([]);
  });

  it('should parse a pinned version', () => {
    const { specs, warnings } = parse(['npm:pi-example-tool@0.13.0']);
    expect(specs).toEqual([{ name: 'pi-example-tool', version: '0.13.0' }]);
    expect(warnings).toEqual([]);
  });

  it('should parse a scoped package name with an implicit latest version', () => {
    const { specs, warnings } = parse(['npm:@scope/tool']);
    expect(specs).toEqual([{ name: '@scope/tool', version: 'latest' }]);
    expect(warnings).toEqual([]);
  });

  it('should parse a scoped package with a version range', () => {
    const { specs, warnings } = parse(['npm:@scope/tool@^1.2.0']);
    expect(specs).toEqual([{ name: '@scope/tool', version: '^1.2.0' }]);
    expect(warnings).toEqual([]);
  });

  it('should warn once and drop non-npm sources, keeping the valid npm: entries', () => {
    const { specs, warnings } = parse([
      'npm:pi-example-tool',
      'git:https://example.com/x',
      'https://example.com/y.tgz'
    ]);
    expect(specs).toEqual([{ name: 'pi-example-tool', version: 'latest' }]);
    expect(warnings).toEqual([
      'settings.json: only npm: package sources are supported — ignored: git:https://example.com/x, https://example.com/y.tgz'
    ]);
  });

  it('should warn and drop a package name attempting path traversal', () => {
    const { specs, warnings } = parse(['npm:../evil']);
    expect(specs).toEqual([]);
    expect(warnings).toEqual(['settings.json: packages entries must be npm:<name>[@<version>] — ignored: npm:../evil']);
  });

  it('should warn and drop an uppercase package name', () => {
    const { specs, warnings } = parse(['npm:UPPER']);
    expect(specs).toEqual([]);
    expect(warnings.join('\n')).toContain('npm:UPPER');
  });

  it('should warn and drop a version smuggling a file: source', () => {
    const { specs, warnings } = parse(['npm:x@file:/etc']);
    expect(specs).toEqual([]);
    expect(warnings.join('\n')).toContain('npm:x@file:/etc');
  });

  it('should warn and drop a version smuggling a git+https: source', () => {
    const { specs, warnings } = parse(['npm:x@git+https://x']);
    expect(specs).toEqual([]);
    expect(warnings.join('\n')).toContain('npm:x@git+https://x');
  });

  it('should combine invalid and non-npm warnings for a mixed list, keeping only the valid entries', () => {
    const { specs, warnings } = parse(['npm:ok', 'ssh://example.com/x.git', 'npm:UPPER']);
    expect(specs).toEqual([{ name: 'ok', version: 'latest' }]);
    expect(warnings).toEqual([
      'settings.json: only npm: package sources are supported — ignored: ssh://example.com/x.git',
      'settings.json: packages entries must be npm:<name>[@<version>] — ignored: npm:UPPER'
    ]);
  });
});

describe('emitPackagesManifest', () => {
  it('should produce a deterministic manifest with dependencies sorted by name', () => {
    const manifest = emitPackagesManifest([
      { name: 'zeta', version: 'latest' },
      { name: 'alpha', version: '1.0.0' }
    ]);
    expect(manifest).toBe(
      `${JSON.stringify(
        { name: 'cradle-agent-packages', private: true, dependencies: { alpha: '1.0.0', zeta: 'latest' } },
        null,
        2
      )}\n`
    );
  });

  it('should emit an empty dependencies object for no specs', () => {
    expect(emitPackagesManifest([])).toBe(
      `${JSON.stringify({ name: 'cradle-agent-packages', private: true, dependencies: {} }, null, 2)}\n`
    );
  });
});

describe('resolvePackageEntries', () => {
  let npmDir: string;
  beforeEach(async () => {
    npmDir = await mkdtemp(join(tmpdir(), 'cradle-packages-'));
  });
  afterEach(async () => {
    await rm(npmDir, { recursive: true, force: true });
  });

  async function addPackage(name: string, manifest: unknown, files: Record<string, string> = {}): Promise<void> {
    const dir = join(npmDir, 'node_modules', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest), 'utf8');
    for (const [rel, content] of Object.entries(files)) {
      const filePath = join(dir, rel);
      await mkdir(join(filePath, '..'), { recursive: true });
      await writeFile(filePath, content, 'utf8');
    }
  }

  it('should resolve multiple pi.extensions entries', async () => {
    await addPackage(
      'multi-tool',
      { name: 'multi-tool', pi: { extensions: ['./index.ts', './extra/other.ts'] } },
      { 'index.ts': '', 'extra/other.ts': '' }
    );
    const { entries, warnings } = await resolvePackageEntries(npmDir, [{ name: 'multi-tool', version: 'latest' }]);
    expect(entries).toEqual([
      join(npmDir, 'node_modules', 'multi-tool', 'index.ts'),
      join(npmDir, 'node_modules', 'multi-tool', 'extra', 'other.ts')
    ]);
    expect(warnings).toEqual([]);
  });

  it('should fall back to index.ts when pi.extensions is absent', async () => {
    await addPackage('simple-tool', { name: 'simple-tool' }, { 'index.ts': '' });
    const { entries, warnings } = await resolvePackageEntries(npmDir, [{ name: 'simple-tool', version: 'latest' }]);
    expect(entries).toEqual([join(npmDir, 'node_modules', 'simple-tool', 'index.ts')]);
    expect(warnings).toEqual([]);
  });

  it('should warn and skip a package that is not installed', async () => {
    const { entries, warnings } = await resolvePackageEntries(npmDir, [{ name: 'missing-tool', version: 'latest' }]);
    expect(entries).toEqual([]);
    expect(warnings).toEqual(['package missing-tool is not installed — skipped']);
  });

  it('should warn and skip a package with malformed JSON in package.json', async () => {
    const dir = join(npmDir, 'node_modules', 'broken-tool');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), '{nope', 'utf8');
    const { entries, warnings } = await resolvePackageEntries(npmDir, [{ name: 'broken-tool', version: 'latest' }]);
    expect(entries).toEqual([]);
    expect(warnings.join('\n')).toContain('broken-tool');
  });

  it('should warn and skip a package whose package.json is not a JSON object', async () => {
    const dir = join(npmDir, 'node_modules', 'array-tool');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), '[1,2,3]', 'utf8');
    const { entries, warnings } = await resolvePackageEntries(npmDir, [{ name: 'array-tool', version: 'latest' }]);
    expect(entries).toEqual([]);
    expect(warnings.join('\n')).toContain('must be a JSON object');
  });

  it('should warn and drop a pi.extensions entry that escapes the package directory', async () => {
    await addPackage('escape-tool', { name: 'escape-tool', pi: { extensions: ['../../evil.ts'] } });
    const { entries, warnings } = await resolvePackageEntries(npmDir, [{ name: 'escape-tool', version: 'latest' }]);
    expect(entries).toEqual([]);
    expect(warnings.join('\n')).toContain('escapes the package directory');
  });

  it('should warn and drop a declared entry file that does not exist', async () => {
    await addPackage('missing-entry-tool', { name: 'missing-entry-tool', pi: { extensions: ['./index.ts'] } });
    const { entries, warnings } = await resolvePackageEntries(npmDir, [
      { name: 'missing-entry-tool', version: 'latest' }
    ]);
    expect(entries).toEqual([]);
    expect(warnings.join('\n')).toContain('not found');
  });

  it('should warn and skip a package declaring no pi extensions and no index.ts fallback', async () => {
    await addPackage('empty-tool', { name: 'empty-tool' });
    const { entries, warnings } = await resolvePackageEntries(npmDir, [{ name: 'empty-tool', version: 'latest' }]);
    expect(entries).toEqual([]);
    expect(warnings).toEqual(['package empty-tool declares no pi extensions — skipped']);
  });

  it('should resolve entries across multiple specs in order, collecting all warnings', async () => {
    await addPackage('good-tool', { name: 'good-tool' }, { 'index.ts': '' });
    const { entries, warnings } = await resolvePackageEntries(npmDir, [
      { name: 'good-tool', version: 'latest' },
      { name: 'missing-tool', version: 'latest' }
    ]);
    expect(entries).toEqual([join(npmDir, 'node_modules', 'good-tool', 'index.ts')]);
    expect(warnings).toEqual(['package missing-tool is not installed — skipped']);
  });
});
