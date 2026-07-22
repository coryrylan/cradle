import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killOn, runCapture, runForeground, runInstall } from './proc.js';

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

  it('overrides the inherited env with the given entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cradle-runforeground-env-'));
    try {
      const outFile = join(dir, 'out.txt');
      process.env['CRADLE_RUNFOREGROUND_TEST'] = 'inherited';
      await runForeground(['sh', '-c', `echo $CRADLE_RUNFOREGROUND_TEST > ${outFile}`], {
        CRADLE_RUNFOREGROUND_TEST: 'overridden'
      });
      expect((await readFile(outFile, 'utf8')).trim()).toBe('overridden');
    } finally {
      delete process.env['CRADLE_RUNFOREGROUND_TEST'];
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runCapture', () => {
  it('throws when given no command', async () => {
    await expect(runCapture([])).rejects.toThrow(/at least one argument/);
  });

  it('captures stderr and the exit code without throwing on a non-zero exit', async () => {
    const result = await runCapture(['sh', '-c', 'echo boom >&2; exit 3']);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('boom');
  });

  it('resolves with a zero exit code and empty stderr on success', async () => {
    const result = await runCapture(['true']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
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
