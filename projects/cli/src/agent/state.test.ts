import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';

import { agentId, stateDirFor, statePaths } from './state.js';

describe('agentId', () => {
  it('should be stable for the same absolute path', () => {
    expect(agentId('/home/u/agents/reviewer')).toBe(agentId('/home/u/agents/reviewer'));
  });

  it('should differ for different paths sharing a basename', () => {
    const first = agentId('/home/u/a/reviewer');
    const second = agentId('/home/u/b/reviewer');
    expect(first).not.toBe(second);
    expect(first.startsWith('reviewer-')).toBe(true);
    expect(second.startsWith('reviewer-')).toBe(true);
  });

  it('should sanitize the basename to lowercase kebab', () => {
    expect(agentId('/x/My Agent!')).toMatch(/^my-agent-[0-9a-f]{8}$/);
  });

  it('should fall back to "agent" when the basename sanitizes away', () => {
    expect(agentId('/x/日本語')).toMatch(/^agent-[0-9a-f]{8}$/);
  });
});

describe('stateDirFor', () => {
  it('should nest under <home>/.cradle/agents by default', () => {
    const dir = stateDirFor('/x/reviewer', '/home/u');
    expect(dir).toBe(join('/home/u', '.cradle', 'agents', agentId('/x/reviewer')));
  });

  it('should honor an explicit stateRoot override', () => {
    expect(stateDirFor('/x/reviewer', '/home/u', '/tmp/state')).toBe(
      join('/tmp/state', 'agents', agentId('/x/reviewer'))
    );
  });

  it('should fall back to <home>/.cradle when the state root override is empty', () => {
    expect(stateDirFor('/x/reviewer', '/home/u', '')).toBe(
      join('/home/u', '.cradle', 'agents', agentId('/x/reviewer'))
    );
  });
});

describe('statePaths', () => {
  it('should place extensions, sessions, and the mise cache inside the state dir', () => {
    expect(statePaths('/s')).toEqual({
      extensionsDir: '/s/extensions',
      sessionsDir: '/s/sessions',
      miseCacheDir: '/s/mise-cache'
    });
  });
});
