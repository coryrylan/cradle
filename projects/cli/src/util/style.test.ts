import { describe, it, expect } from 'bun:test';
import { styleWarning } from './style.js';

describe('styleWarning', () => {
  it('should wrap with ANSI yellow codes when isTty is true', () => {
    const result = styleWarning('test warning', true);
    expect(result).toBe('\x1b[33mtest warning\x1b[0m');
  });

  it('should return the input string unchanged when isTty is false', () => {
    const result = styleWarning('test warning', false);
    expect(result).toBe('test warning');
  });
});
