import { describe, it, expect } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWhichStub, lookupBin, miseShimPath, requireBin } from './which.js';

async function withMiseHome(run: (home: string, shims: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'cradle-home-'));
  const shims = join(home, '.local', 'share', 'mise', 'shims');
  try {
    await mkdir(shims, { recursive: true });
    await run(home, shims);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe('miseShimPath', () => {
  it('resolves a tool installed as a mise shim', async () => {
    await withMiseHome(async (home, shims) => {
      await writeFile(join(shims, 'nono'), '');
      expect(miseShimPath('nono', home)).toBe(join(shims, 'nono'));
    });
  });

  it('returns null when the shim is absent', async () => {
    await withMiseHome(async home => {
      expect(miseShimPath('nono', home)).toBeNull();
    });
  });
});

describe('lookupBin', () => {
  it('returns the resolved path when found', () => {
    expect(lookupBin('nono', createWhichStub({ nono: '/usr/bin/nono' }))).toBe('/usr/bin/nono');
  });

  it('returns null when not found', () => {
    expect(lookupBin('nono', createWhichStub({}))).toBeNull();
  });

  it('falls back to Bun.which for a definitely-absent bin', () => {
    expect(lookupBin('cradle-not-a-real-bin-xyz')).toBeNull();
  });
});

describe('requireBin', () => {
  it('returns the resolved path when found', () => {
    expect(requireBin('pi', createWhichStub({ pi: '/opt/pi' }))).toBe('/opt/pi');
  });

  it('throws a friendly error pointing at `cradle doctor`', () => {
    expect(() => requireBin('pi', createWhichStub({}))).toThrow(/Required executable "pi" not found/);
    expect(() => requireBin('pi', createWhichStub({}))).toThrow(/cradle doctor/);
  });
});
