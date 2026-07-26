import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';

import { applyDeltaPatterns, applyPatterns, isOverridePattern } from './package-filters.js';

const root = join('/pkg', 'my-tool');
const files = [
  join(root, 'extensions', 'alpha.ts'),
  join(root, 'extensions', 'legacy.ts'),
  join(root, 'extensions', 'nested', 'index.ts'),
  join(root, 'index.ts')
];

function select(patterns: readonly string[]): string[] {
  return applyPatterns(files, patterns, root);
}

describe('isOverridePattern', () => {
  it('should be true for the three override prefixes', () => {
    expect(['!x', '+x', '-x'].map(isOverridePattern)).toEqual([true, true, true]);
  });

  it('should be false for a plain source path or glob', () => {
    expect(['extensions', 'extensions/*.ts'].map(isOverridePattern)).toEqual([false, false]);
  });
});

describe('applyPatterns', () => {
  it('should keep every file when no patterns are given', () => {
    expect(select([])).toEqual(files);
  });

  it('should keep every file when only exclusions are given', () => {
    expect(select(['!extensions/legacy.ts'])).toEqual(files.filter(file => !file.endsWith('legacy.ts')));
  });

  it('should narrow to the include glob', () => {
    expect(select(['extensions/*.ts'])).toEqual([
      join(root, 'extensions', 'alpha.ts'),
      join(root, 'extensions', 'legacy.ts')
    ]);
  });

  it('should match an include glob against a bare filename', () => {
    expect(select(['alpha.ts'])).toEqual([join(root, 'extensions', 'alpha.ts')]);
  });

  it('should exclude glob matches from the included set', () => {
    expect(select(['extensions/*.ts', '!extensions/legacy.ts'])).toEqual([join(root, 'extensions', 'alpha.ts')]);
  });

  it('should force-include an exact path the excludes dropped', () => {
    expect(select(['extensions/*.ts', '!extensions/*.ts', '+extensions/legacy.ts'])).toEqual([
      join(root, 'extensions', 'legacy.ts')
    ]);
  });

  it('should force-include an exact path the includes never selected', () => {
    expect(select(['extensions/alpha.ts', '+index.ts'])).toEqual([
      join(root, 'extensions', 'alpha.ts'),
      join(root, 'index.ts')
    ]);
  });

  it('should treat a leading ./ on an exact path as the package root', () => {
    expect(select(['extensions/alpha.ts', '+./index.ts'])).toEqual([
      join(root, 'extensions', 'alpha.ts'),
      join(root, 'index.ts')
    ]);
  });

  it('should force-exclude an exact path over every other pattern', () => {
    expect(select(['extensions/*.ts', '+extensions/legacy.ts', '-extensions/legacy.ts'])).toEqual([
      join(root, 'extensions', 'alpha.ts')
    ]);
  });

  it('should not treat an exact force-include as a glob', () => {
    expect(applyPatterns(files, ['alpha.ts', '+extensions/*.ts'], root)).toEqual([
      join(root, 'extensions', 'alpha.ts')
    ]);
  });

  it('should match an include glob against a bare filename in every directory', () => {
    expect(select(['index.ts'])).toEqual([join(root, 'extensions', 'nested', 'index.ts'), join(root, 'index.ts')]);
  });

  it('should preserve input order', () => {
    expect(select(['+index.ts', 'extensions/alpha.ts'])).toEqual([
      join(root, 'extensions', 'alpha.ts'),
      join(root, 'index.ts')
    ]);
  });
});

describe('applyDeltaPatterns', () => {
  it('should select nothing when no patterns are given', () => {
    expect(applyDeltaPatterns(files, [], root)).toEqual([]);
  });

  it('should select only files a plain glob names', () => {
    expect(applyDeltaPatterns(files, ['extensions/*.ts'], root)).toEqual([
      join(root, 'extensions', 'alpha.ts'),
      join(root, 'extensions', 'legacy.ts')
    ]);
  });

  it('should let a later pattern override an earlier one', () => {
    expect(applyDeltaPatterns(files, ['extensions/*.ts', '-extensions/legacy.ts'], root)).toEqual([
      join(root, 'extensions', 'alpha.ts')
    ]);
  });

  it('should ignore files only a negative pattern names', () => {
    expect(applyDeltaPatterns(files, ['!extensions/*.ts'], root)).toEqual([]);
  });
});
