import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveAgentRef } from './aliases.js';

let home: string;
let cwd: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cradle-alias-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'cradle-alias-cwd-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const settingsPath = () => join(home, '.cradle', 'settings.json');

async function writeSettings(value: unknown): Promise<void> {
  await mkdir(join(home, '.cradle'), { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(value), 'utf8');
}

describe('resolveAgentRef', () => {
  it('should pass path-shaped refs through untouched, never consulting the alias table', async () => {
    for (const ref of ['./my-agent', '../x', '/abs/x', '~/x', '.', '..']) {
      expect(await resolveAgentRef(ref, { home, cwd })).toEqual({ dir: ref, warnings: [] });
    }
  });

  it('should resolve a bare name via the alias table', async () => {
    await writeSettings({ agents: { 'my-agent': { path: '/abs/agents/my-agent' } } });
    expect(await resolveAgentRef('my-agent', { home, cwd })).toEqual({
      dir: '/abs/agents/my-agent',
      warnings: []
    });
  });

  it('should expand ~ and $HOME in an alias path against home', async () => {
    await writeSettings({ agents: { 'my-agent': { path: '~/agents/my-agent' }, other: { path: '$HOME/x' } } });
    expect((await resolveAgentRef('my-agent', { home, cwd })).dir).toBe(join(home, 'agents', 'my-agent'));
    expect((await resolveAgentRef('other', { home, cwd })).dir).toBe(join(home, 'x'));
  });

  it('should fall back to the cwd-relative folder, resolved against the injected cwd, when the settings file is missing', async () => {
    await mkdir(join(cwd, 'hello'), { recursive: true });
    expect(await resolveAgentRef('hello', { home, cwd })).toEqual({ dir: join(cwd, 'hello'), warnings: [] });
  });

  it('should throw on malformed JSON', async () => {
    await mkdir(join(home, '.cradle'), { recursive: true });
    await writeFile(settingsPath(), '{not json', 'utf8');
    await expect(resolveAgentRef('my-agent', { home, cwd })).rejects.toThrow('is not valid JSON');
  });

  it('should warn and drop when the settings file itself is not a JSON object', async () => {
    await mkdir(join(home, '.cradle'), { recursive: true });
    await writeFile(settingsPath(), JSON.stringify([1, 2, 3]), 'utf8');
    await mkdir(join(cwd, 'my-agent'), { recursive: true });
    const result = await resolveAgentRef('my-agent', { home, cwd });
    expect(result.dir).toBe(join(cwd, 'my-agent'));
    expect(result.warnings.join('\n')).toContain(`${settingsPath()}: settings must be a JSON object — ignored`);
  });

  it('should warn and drop when agents is not an object, falling back to the cwd-relative path', async () => {
    await writeSettings({ agents: 'nope' });
    await mkdir(join(cwd, 'my-agent'), { recursive: true });
    const result = await resolveAgentRef('my-agent', { home, cwd });
    expect(result.dir).toBe(join(cwd, 'my-agent'));
    expect(result.warnings.join('\n')).toContain(`${settingsPath()}: agents must be an object — ignored`);
  });

  it('should warn and drop when an entry is not an object', async () => {
    await writeSettings({ agents: { 'my-agent': 'nope' } });
    await mkdir(join(cwd, 'my-agent'), { recursive: true });
    const result = await resolveAgentRef('my-agent', { home, cwd });
    expect(result.warnings.join('\n')).toContain(
      `${settingsPath()}: agents.my-agent must be an object with a "path" — ignored`
    );
  });

  it('should warn and drop when path is missing or not a non-empty string', async () => {
    await writeSettings({ agents: { 'my-agent': {}, other: { path: '   ' } } });
    await mkdir(join(cwd, 'my-agent'), { recursive: true });
    const result = await resolveAgentRef('my-agent', { home, cwd });
    const text = result.warnings.join('\n');
    expect(text).toContain(`${settingsPath()}: agents.my-agent.path must be a non-empty string — ignored`);
    expect(text).toContain(`${settingsPath()}: agents.other.path must be a non-empty string — ignored`);
  });

  it('should warn and drop a non-path-shaped alias path', async () => {
    await writeSettings({ agents: { 'my-agent': { path: 'relative/path' } } });
    await mkdir(join(cwd, 'my-agent'), { recursive: true });
    const result = await resolveAgentRef('my-agent', { home, cwd });
    expect(result.dir).toBe(join(cwd, 'my-agent'));
    expect(result.warnings.join('\n')).toContain(
      `${settingsPath()}: agents.my-agent.path must be an absolute, ~/, or $HOME/ path — ignored: relative/path`
    );
  });

  it('should warn on unknown top-level keys', async () => {
    await writeSettings({ agents: {}, bogus: 1 });
    await mkdir(join(cwd, 'my-agent'), { recursive: true });
    const result = await resolveAgentRef('my-agent', { home, cwd });
    expect(result.warnings.join('\n')).toContain(`${settingsPath()}: unsupported keys ignored: bogus`);
  });

  it('should warn with the shadow message when an alias also matches a cwd-local directory', async () => {
    await writeSettings({ agents: { 'my-agent': { path: '/abs/agents/my-agent' } } });
    await mkdir(join(cwd, 'my-agent'), { recursive: true });
    const result = await resolveAgentRef('my-agent', { home, cwd });
    expect(result.dir).toBe('/abs/agents/my-agent');
    expect(result.warnings).toEqual([
      'started alias "my-agent" (/abs/agents/my-agent) — a directory named my-agent exists in the current directory; use ./my-agent to run it instead'
    ]);
  });

  it('should normalize an alias path, so a trailing slash never reaches the folder loader or the warning', async () => {
    await writeSettings({ agents: { 'my-agent': { path: '/abs/agents/my-agent/' } } });
    expect((await resolveAgentRef('my-agent', { home, cwd })).dir).toBe('/abs/agents/my-agent');
    // The shadow warning is built from the resolved value, so it prints clean too.
    await mkdir(join(cwd, 'my-agent'), { recursive: true });
    const shadowed = await resolveAgentRef('my-agent', { home, cwd });
    expect(shadowed.warnings.join('\n')).toContain('started alias "my-agent" (/abs/agents/my-agent) —');
  });

  it('should not warn when the alias resolves and no cwd-local directory shadows it', async () => {
    await writeSettings({ agents: { 'my-agent': { path: '/abs/agents/my-agent' } } });
    const result = await resolveAgentRef('my-agent', { home, cwd });
    expect(result.warnings).toEqual([]);
  });

  it('should throw naming both misses, listing known agents', async () => {
    await writeSettings({ agents: { alpha: { path: '/a' }, beta: { path: '/b' } } });
    await expect(resolveAgentRef('nope', { home, cwd })).rejects.toThrow(
      `agent folder not found: ${join(cwd, 'nope')} — and no "agents.nope" entry in ${settingsPath()} (known agents: alpha, beta)`
    );
  });

  it('should drop the known-agents clause when the table is empty', async () => {
    await expect(resolveAgentRef('nope', { home, cwd })).rejects.toThrow(
      `agent folder not found: ${join(cwd, 'nope')} — and no "agents.nope" entry in ${settingsPath()}`
    );
  });

  it('should not let a bad sibling entry break a good one', async () => {
    await writeSettings({ agents: { 'my-agent': { path: '/abs/agents/my-agent' }, broken: 'nope' } });
    const result = await resolveAgentRef('my-agent', { home, cwd });
    expect(result.dir).toBe('/abs/agents/my-agent');
    expect(result.warnings.join('\n')).toContain(
      `${settingsPath()}: agents.broken must be an object with a "path" — ignored`
    );
  });
});
