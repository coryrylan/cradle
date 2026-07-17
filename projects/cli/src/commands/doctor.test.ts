import { describe, it, expect } from 'bun:test';
import { createWhichStub } from '../util/which.js';
import { doctorExitCode, formatDoctorReport, runDoctor } from './doctor.js';

const allFound = { pi: '/shims/pi', nono: '/shims/nono', mise: '/shims/mise' };

describe('runDoctor', () => {
  it('should require pi and recommend nono and mise', async () => {
    const checks = await runDoctor({ which: createWhichStub({}) });
    expect(checks.map(check => check.name)).toEqual(['pi', 'nono', 'mise']);
    expect(checks.find(check => check.name === 'pi')?.required).toBe(true);
    expect(checks.find(check => check.name === 'nono')?.required).toBe(false);
    expect(checks.find(check => check.name === 'mise')?.required).toBe(false);
  });

  it('should attach a not-required note to missing optional tools', async () => {
    const missing = await runDoctor({ which: createWhichStub({ pi: '/p' }) });
    expect(missing.find(check => check.name === 'nono')?.note).toContain('required for sandboxed runs');
    expect(missing.find(check => check.name === 'mise')?.note).toContain('recommended');
    const present = await runDoctor({ which: createWhichStub(allFound) });
    expect(present.find(check => check.name === 'nono')?.note).toBeUndefined();
    expect(present.find(check => check.name === 'mise')?.note).toBeUndefined();
  });

  it('should report resolved paths for found bins', async () => {
    const checks = await runDoctor({ which: createWhichStub(allFound) });
    expect(checks.find(check => check.name === 'pi')?.found).toBe('/shims/pi');
  });

  it('should populate version via the injected readVersion for found bins', async () => {
    const readVersion = async (binPath: string): Promise<string | null> => `v(${binPath})`;
    const checks = await runDoctor({ which: createWhichStub(allFound), readVersion });
    expect(checks.find(check => check.name === 'pi')?.version).toBe('v(/shims/pi)');
    expect(checks.find(check => check.name === 'nono')?.version).toBe('v(/shims/nono)');
    expect(checks.find(check => check.name === 'mise')?.version).toBe('v(/shims/mise)');
  });

  it('should report version: null when readVersion is absent', async () => {
    const checks = await runDoctor({ which: createWhichStub(allFound) });
    expect(checks.every(check => check.version === null)).toBe(true);
  });

  it('should report version: null when readVersion returns null', async () => {
    const checks = await runDoctor({ which: createWhichStub(allFound), readVersion: async () => null });
    expect(checks.every(check => check.version === null)).toBe(true);
  });

  it('should never call readVersion for a bin that was not found', async () => {
    const calls: string[] = [];
    const readVersion = async (binPath: string): Promise<string | null> => {
      calls.push(binPath);
      return '1.0.0';
    };
    const checks = await runDoctor({ which: createWhichStub({ pi: '/shims/pi' }), readVersion });
    expect(calls).toEqual(['/shims/pi']);
    expect(checks.find(check => check.name === 'nono')?.version).toBeNull();
  });
});

describe('doctorExitCode', () => {
  it('should return 1 when pi is missing', async () => {
    expect(doctorExitCode(await runDoctor({ which: createWhichStub({ nono: '/n', mise: '/m' }) }))).toBe(1);
  });

  it('should return 0 when pi is present even if optional tools are absent', async () => {
    expect(doctorExitCode(await runDoctor({ which: createWhichStub({ pi: '/p' }) }))).toBe(0);
  });

  it('should return 0 when everything is present', async () => {
    expect(doctorExitCode(await runDoctor({ which: createWhichStub(allFound) }))).toBe(0);
  });
});

describe('formatDoctorReport', () => {
  it('should render found and missing checks distinctly and attach notes', () => {
    const report = formatDoctorReport([
      { name: 'pi', bin: 'pi', required: true, found: '/shims/pi', version: '1.2.3', note: 'heads up' },
      { name: 'nono', bin: 'nono', required: true, found: null, version: null }
    ]);
    expect(report).toContain('✓ pi');
    expect(report).toContain('⚠ heads up');
    expect(report).toContain('✗ nono');
    expect(report).toContain('MISSING (required)');
  });

  it('should render a missing recommended tool as a soft note, not a required failure', () => {
    const report = formatDoctorReport([{ name: 'mise', bin: 'mise', required: false, found: null, version: null }]);
    expect(report).toContain('○ mise');
    expect(report).toContain('not found (recommended)');
    expect(report).not.toContain('MISSING (required)');
  });

  it('should show the version column before the path when the version is known', () => {
    const report = formatDoctorReport([
      { name: 'pi', bin: 'pi', required: true, found: '/shims/pi', version: '1.2.3' }
    ]);
    expect(report).toContain('✓ pi       1.2.3  /shims/pi');
  });

  it('should render a "?" placeholder in the version column when the version is unknown', () => {
    const report = formatDoctorReport([{ name: 'pi', bin: 'pi', required: true, found: '/shims/pi', version: null }]);
    expect(report).toContain('✓ pi       ?  /shims/pi');
  });

  it('should leave missing-bin lines unaffected by the version column', () => {
    const report = formatDoctorReport([{ name: 'nono', bin: 'nono', required: true, found: null, version: null }]);
    expect(report).toBe('✗ nono     MISSING (required)');
  });
});
