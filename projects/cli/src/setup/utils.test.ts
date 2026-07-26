import { describe, it, expect } from 'bun:test';
import {
  getErrorMessage,
  hasErrorCode,
  isPathShaped,
  isRecord,
  isStringArray,
  parseJson,
  quoteCommandPart,
  warnUnsupportedKeys
} from './utils.js';

describe('isRecord', () => {
  it('is true only for plain objects', () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord('x')).toBe(false);
  });
});

describe('parseJson', () => {
  it('parses valid JSON', () => {
    expect(parseJson('{"a":1}', 'f.json')).toEqual({ a: 1 });
  });

  it('throws a path-qualified error on invalid JSON', () => {
    expect(() => parseJson('{bad', '/tmp/f.json')).toThrow(/\/tmp\/f\.json is not valid JSON/);
  });
});

describe('small helpers', () => {
  it('getErrorMessage unwraps Error and stringifies the rest', () => {
    expect(getErrorMessage(new Error('Boom'))).toBe('Boom');
    expect(getErrorMessage('plain')).toBe('plain');
  });

  it('hasErrorCode matches the code property', () => {
    expect(hasErrorCode({ code: 'ENOENT' }, 'ENOENT')).toBe(true);
    expect(hasErrorCode({ code: 'EACCES' }, 'ENOENT')).toBe(false);
    expect(hasErrorCode(null, 'ENOENT')).toBe(false);
  });

  it('quoteCommandPart only quotes parts with shell-significant chars', () => {
    expect(quoteCommandPart('plain-arg')).toBe('plain-arg');
    expect(quoteCommandPart('has space')).toBe("'has space'");
    expect(quoteCommandPart("it's")).toBe("'it'\\''s'");
  });
});

describe('isStringArray', () => {
  it('is true for an array of strings, including empty', () => {
    expect(isStringArray(['a', 'b'])).toBe(true);
    expect(isStringArray([])).toBe(true);
  });

  it('is false for a non-array', () => {
    expect(isStringArray('nope')).toBe(false);
    expect(isStringArray({ a: 1 })).toBe(false);
    expect(isStringArray(null)).toBe(false);
  });

  it('is false for a mixed-type array', () => {
    expect(isStringArray(['a', 1])).toBe(false);
  });
});

describe('isPathShaped', () => {
  it('accepts absolute, ~/, and $HOME/ prefixed paths', () => {
    expect(isPathShaped('/abs')).toBe(true);
    expect(isPathShaped('~/x')).toBe(true);
    expect(isPathShaped('~')).toBe(true);
    expect(isPathShaped('$HOME/x')).toBe(true);
    expect(isPathShaped('$HOME')).toBe(true);
  });

  it('accepts Windows drive-letter and UNC absolute paths', () => {
    expect(isPathShaped('C:\\agents\\hello')).toBe(true);
    expect(isPathShaped('c:/agents/hello')).toBe(true);
    expect(isPathShaped('\\\\server\\share')).toBe(true);
  });

  it('rejects relative paths, bare names, flags, and near-misses', () => {
    expect(isPathShaped('./x')).toBe(false);
    expect(isPathShaped('x')).toBe(false);
    expect(isPathShaped('-flag')).toBe(false);
    expect(isPathShaped('$HOMEx')).toBe(false);
    expect(isPathShaped('~x')).toBe(false);
    expect(isPathShaped('C:')).toBe(false);
    expect(isPathShaped('C:relative')).toBe(false);
  });
});

describe('warnUnsupportedKeys', () => {
  it('warns naming every key not in the supported list', () => {
    const warnings: string[] = [];
    warnUnsupportedKeys({ a: 1, b: 2, bogus: 3 }, 'f.json', ['a', 'b'], warnings);
    expect(warnings).toEqual(['f.json: unsupported keys ignored: bogus']);
  });

  it('does not warn when every key is supported', () => {
    const warnings: string[] = [];
    warnUnsupportedKeys({ a: 1 }, 'f.json', ['a', 'b'], warnings);
    expect(warnings).toEqual([]);
  });
});
