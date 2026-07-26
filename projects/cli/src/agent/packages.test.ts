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

  it('should warn and drop when packages is not an array', () => {
    const { specs, warnings } = parse({ nope: true });
    expect(specs).toEqual([]);
    expect(warnings).toEqual(['settings.json: packages must be an array — ignored']);
  });

  it('should warn and drop an entry that is neither a source string nor an object, keeping the valid ones', () => {
    const { specs, warnings } = parse(['npm:ok', 7]);
    expect(specs).toEqual([{ name: 'ok', version: 'latest' }]);
    expect(warnings).toEqual([
      'settings.json: packages entries must be a source string or a { "source": … } object — ignored: 7'
    ]);
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

  it('should parse the object form, which carries the same npm: source', () => {
    const { specs, warnings } = parse([{ source: 'npm:pi-example-tool@1.2.0' }]);
    expect(specs).toEqual([{ name: 'pi-example-tool', version: '1.2.0' }]);
    expect(warnings).toEqual([]);
  });

  it('should carry the object form extensions filter onto the spec', () => {
    const { specs, warnings } = parse([
      { source: 'npm:tool', extensions: ['extensions/*.ts', '!extensions/legacy.ts'] }
    ]);
    expect(specs).toEqual([
      { name: 'tool', version: 'latest', extensions: ['extensions/*.ts', '!extensions/legacy.ts'] }
    ]);
    expect(warnings).toEqual([]);
  });

  it('should carry an empty extensions filter, which selects no extensions', () => {
    const { specs, warnings } = parse([{ source: 'npm:tool', extensions: [] }]);
    expect(specs).toEqual([{ name: 'tool', version: 'latest', extensions: [] }]);
    expect(warnings).toEqual([]);
  });

  it('should carry autoload: false as the delta filter flag', () => {
    const { specs, warnings } = parse([{ source: 'npm:tool', autoload: false, extensions: ['+index.ts'] }]);
    expect(specs).toEqual([{ name: 'tool', version: 'latest', extensions: ['+index.ts'], autoloadDisabled: true }]);
    expect(warnings).toEqual([]);
  });

  it('should ignore autoload: true, the default', () => {
    const { specs, warnings } = parse([{ source: 'npm:tool', autoload: true }]);
    expect(specs).toEqual([{ name: 'tool', version: 'latest' }]);
    expect(warnings).toEqual([]);
  });

  it('should warn and drop a non-boolean autoload', () => {
    const { specs, warnings } = parse([{ source: 'npm:tool', autoload: 'false' }]);
    expect(specs).toEqual([{ name: 'tool', version: 'latest' }]);
    expect(warnings).toEqual(['settings.json: packages entry npm:tool: autoload must be a boolean — ignored']);
  });

  it('should warn and drop an extensions filter that is not an array of strings', () => {
    const { specs, warnings } = parse([{ source: 'npm:tool', extensions: 'index.ts' }]);
    expect(specs).toEqual([{ name: 'tool', version: 'latest' }]);
    expect(warnings).toEqual([
      'settings.json: packages entry npm:tool: extensions must be an array of strings — ignored'
    ]);
  });

  it('should warn that the sibling resource filters are not delivered', () => {
    const { specs, warnings } = parse([{ source: 'npm:tool', skills: [], prompts: ['prompts/review.md'] }]);
    expect(specs).toEqual([{ name: 'tool', version: 'latest' }]);
    expect(warnings).toEqual([
      "settings.json: packages entry npm:tool: cradle loads a package's extensions and nothing else — ignored: skills, prompts"
    ]);
  });

  it('should warn about unknown filter keys', () => {
    const { specs, warnings } = parse([{ source: 'npm:tool', nope: true }]);
    expect(specs).toEqual([{ name: 'tool', version: 'latest' }]);
    expect(warnings).toEqual(['settings.json: packages entry npm:tool: unknown filter keys — ignored: nope']);
  });

  it('should warn and drop an object entry with no source string', () => {
    const { specs, warnings } = parse([{ extensions: ['*.ts'] }, 'npm:ok']);
    expect(specs).toEqual([{ name: 'ok', version: 'latest' }]);
    expect(warnings).toEqual([
      'settings.json: packages entries must be a source string or a { "source": … } object — ignored: {"extensions":["*.ts"]}'
    ]);
  });

  it('should drop an object entry carrying a non-npm source', () => {
    const { specs, warnings } = parse([{ source: 'git:github.com/user/repo', extensions: ['*.ts'] }]);
    expect(specs).toEqual([]);
    expect(warnings).toEqual([
      'settings.json: only npm: package sources are supported — ignored: git:github.com/user/repo'
    ]);
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

  it('should fall back to index.js when there is no index.ts', async () => {
    await addPackage('js-tool', { name: 'js-tool' }, { 'index.js': '' });
    const { entries, warnings } = await resolvePackageEntries(npmDir, [{ name: 'js-tool', version: 'latest' }]);
    expect(entries).toEqual([join(npmDir, 'node_modules', 'js-tool', 'index.js')]);
    expect(warnings).toEqual([]);
  });

  describe('discovery', () => {
    async function addDirPackage(name: string, manifest: unknown): Promise<string> {
      await addPackage(name, manifest, {
        'extensions/alpha.ts': '',
        'extensions/legacy.ts': '',
        'extensions/nested/index.ts': '',
        'extensions/notes.md': ''
      });
      return join(npmDir, 'node_modules', name, 'extensions');
    }

    it('should expand a declared directory into its top-level files and each subdirectory index', async () => {
      const dir = await addDirPackage('dir-tool', { name: 'dir-tool', pi: { extensions: ['./extensions'] } });
      const { entries, warnings } = await resolvePackageEntries(npmDir, [{ name: 'dir-tool', version: 'latest' }]);
      expect(entries).toEqual([join(dir, 'alpha.ts'), join(dir, 'legacy.ts'), join(dir, 'nested', 'index.ts')]);
      expect(warnings).toEqual([]);
    });

    it('should discover the convention extensions directory when the manifest declares none', async () => {
      const dir = await addDirPackage('convention-tool', { name: 'convention-tool' });
      const { entries, warnings } = await resolvePackageEntries(npmDir, [
        { name: 'convention-tool', version: 'latest' }
      ]);
      expect(entries).toEqual([join(dir, 'alpha.ts'), join(dir, 'legacy.ts'), join(dir, 'nested', 'index.ts')]);
      expect(warnings).toEqual([]);
    });

    it('should expand a declared glob', async () => {
      const dir = await addDirPackage('glob-tool', { name: 'glob-tool', pi: { extensions: ['extensions/*.ts'] } });
      const { entries, warnings } = await resolvePackageEntries(npmDir, [{ name: 'glob-tool', version: 'latest' }]);
      expect(entries).toEqual([join(dir, 'alpha.ts'), join(dir, 'legacy.ts')]);
      expect(warnings).toEqual([]);
    });

    it('should apply the manifest own exclusion patterns', async () => {
      const dir = await addDirPackage('manifest-filter-tool', {
        name: 'manifest-filter-tool',
        pi: { extensions: ['./extensions', '!extensions/legacy.ts'] }
      });
      const { entries, warnings } = await resolvePackageEntries(npmDir, [
        { name: 'manifest-filter-tool', version: 'latest' }
      ]);
      expect(entries).toEqual([join(dir, 'alpha.ts'), join(dir, 'nested', 'index.ts')]);
      expect(warnings).toEqual([]);
    });

    it('should warn and drop a glob that escapes the package directory', async () => {
      await addPackage('neighbor-tool', { name: 'neighbor-tool' }, { 'index.ts': '' });
      await addDirPackage('glob-escape-tool', {
        name: 'glob-escape-tool',
        pi: { extensions: ['../neighbor-tool/*.ts'] }
      });
      const { entries, warnings } = await resolvePackageEntries(npmDir, [
        { name: 'glob-escape-tool', version: 'latest' }
      ]);
      expect(entries).toEqual([]);
      expect(warnings.join('\n')).toContain('escapes the package directory');
    });
  });

  describe('settings filter', () => {
    const declared = { name: 'filter-tool', pi: { extensions: ['./extensions'] } };
    async function addFilterPackage(): Promise<string> {
      await addPackage('filter-tool', declared, {
        'extensions/alpha.ts': '',
        'extensions/legacy.ts': '',
        'extensions/nested/index.ts': ''
      });
      return join(npmDir, 'node_modules', 'filter-tool', 'extensions');
    }

    it('should keep every declared extension when the spec carries no filter', async () => {
      const dir = await addFilterPackage();
      const { entries } = await resolvePackageEntries(npmDir, [{ name: 'filter-tool', version: 'latest' }]);
      expect(entries).toEqual([join(dir, 'alpha.ts'), join(dir, 'legacy.ts'), join(dir, 'nested', 'index.ts')]);
    });

    it('should narrow to the filter include glob', async () => {
      const dir = await addFilterPackage();
      const { entries, warnings } = await resolvePackageEntries(npmDir, [
        { name: 'filter-tool', version: 'latest', extensions: ['extensions/*.ts'] }
      ]);
      expect(entries).toEqual([join(dir, 'alpha.ts'), join(dir, 'legacy.ts')]);
      expect(warnings).toEqual([]);
    });

    it('should drop filter exclusions', async () => {
      const dir = await addFilterPackage();
      const { entries } = await resolvePackageEntries(npmDir, [
        { name: 'filter-tool', version: 'latest', extensions: ['!extensions/legacy.ts'] }
      ]);
      expect(entries).toEqual([join(dir, 'alpha.ts'), join(dir, 'nested', 'index.ts')]);
    });

    it('should select nothing, silently, for an empty filter', async () => {
      await addFilterPackage();
      const { entries, warnings } = await resolvePackageEntries(npmDir, [
        { name: 'filter-tool', version: 'latest', extensions: [] }
      ]);
      expect(entries).toEqual([]);
      expect(warnings).toEqual([]);
    });

    it('should select only the named patterns when autoload is disabled', async () => {
      const dir = await addFilterPackage();
      const { entries } = await resolvePackageEntries(npmDir, [
        { name: 'filter-tool', version: 'latest', extensions: ['+extensions/alpha.ts'], autoloadDisabled: true }
      ]);
      expect(entries).toEqual([join(dir, 'alpha.ts')]);
    });

    it('should select nothing when autoload is disabled with no patterns', async () => {
      await addFilterPackage();
      const { entries, warnings } = await resolvePackageEntries(npmDir, [
        { name: 'filter-tool', version: 'latest', autoloadDisabled: true }
      ]);
      expect(entries).toEqual([]);
      expect(warnings).toEqual([]);
    });
  });
});
