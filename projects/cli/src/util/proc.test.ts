import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killOn, runForeground, runInstall } from './proc.js';

describe('killOn', () => {
  it('returns a handler that forwards the signal to the process', () => {
    const calls: string[] = [];
    const handler = killOn({ kill: signal => calls.push(signal) }, 'SIGINT');
    handler();
    expect(calls).toEqual(['SIGINT']);
  });
});

describe('runForeground', () => {
  it('throws when given no command', async () => {
    await expect(runForeground([])).rejects.toThrow(/at least one argument/);
  });

  it('propagates the child exit code on success', async () => {
    expect(await runForeground(['true'])).toBe(0);
  });

  it('propagates a non-zero child exit code', async () => {
    expect(await runForeground(['false'])).toBe(1);
  });

  it('detaches its signal handlers so sequential calls do not leak listeners', async () => {
    const baseline = process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');
    await runForeground(['true']);
    await runForeground(['true']);
    expect(process.listenerCount('SIGINT') + process.listenerCount('SIGTERM')).toBe(baseline);
  });
});

describe('runInstall', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'cradle-runinstall-')));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('throws when given no command', async () => {
    await expect(runInstall([], dir)).rejects.toThrow(/at least one argument/);
  });

  it('resolves when the install command exits zero', async () => {
    await expect(runInstall(['true'], dir)).resolves.toBeUndefined();
  });

  it('throws a named error naming the command and exit code on a non-zero exit', async () => {
    await expect(runInstall(['false'], dir)).rejects.toThrow('package install failed (false exited 1)');
  });

  it('runs the command in the given cwd', async () => {
    await runInstall(['sh', '-c', 'pwd > out.txt'], dir);
    expect((await readFile(join(dir, 'out.txt'), 'utf8')).trim()).toBe(dir);
  });
});
