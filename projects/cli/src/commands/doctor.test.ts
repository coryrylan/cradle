import { describe, it, expect } from 'bun:test';
import { createWhichStub } from '../util/which.js';
import { doctorExitCode, formatDoctorReport, runDoctor } from './doctor.js';

const allFound = { pi: '/shims/pi', nono: '/shims/nono', sbx: '/shims/sbx', mise: '/shims/mise' };
// Pinned so these assertions are deterministic on any CI/dev machine —
// scheduleBackendBin's own platform branching is covered separately below.
const darwin = { platform: 'darwin' as const };

describe('runDoctor', () => {
  it('should require pi and recommend nono, sbx, mise, and the platform scheduling backend', async () => {
    const checks = await runDoctor({ which: createWhichStub({}), ...darwin });
    expect(checks.map(check => check.name)).toEqual(['pi', 'nono', 'sbx', 'mise', 'launchctl']);
    expect(checks.find(check => check.name === 'pi')?.required).toBe(true);
    expect(checks.find(check => check.name === 'nono')?.required).toBe(false);
    expect(checks.find(check => check.name === 'sbx')?.required).toBe(false);
    expect(checks.find(check => check.name === 'mise')?.required).toBe(false);
    expect(checks.find(check => check.name === 'launchctl')?.required).toBe(false);
  });

  it('should attach a not-required note to missing optional tools', async () => {
    const missing = await runDoctor({ which: createWhichStub({ pi: '/p' }), ...darwin });
    expect(missing.find(check => check.name === 'nono')?.note).toContain('required for sandboxed runs');
    expect(missing.find(check => check.name === 'sbx')?.note).toContain('required for sbx-backend runs');
    expect(missing.find(check => check.name === 'mise')?.note).toContain('recommended');
    expect(missing.find(check => check.name === 'launchctl')?.note).toContain('recommended for `cradle schedule`');
    const present = await runDoctor({ which: createWhichStub({ ...allFound, launchctl: '/l' }), ...darwin });
    expect(present.find(check => check.name === 'nono')?.note).toBeUndefined();
    expect(present.find(check => check.name === 'sbx')?.note).toBeUndefined();
    expect(present.find(check => check.name === 'mise')?.note).toBeUndefined();
    expect(present.find(check => check.name === 'launchctl')?.note).toBeUndefined();
  });

  it('should ask for the sbx version via its version subcommand, and the default flag for the rest', async () => {
    const calls: (readonly string[] | undefined)[] = [];
    const readVersion = async (_binPath: string, args?: readonly string[]): Promise<string | null> => {
      calls.push(args);
      return '1.0.0';
    };
    await runDoctor({ which: createWhichStub(allFound), readVersion, ...darwin });
    expect(calls).toEqual([undefined, undefined, ['version'], undefined, undefined]);
  });

  it('should report resolved paths for found bins', async () => {
    const checks = await runDoctor({ which: createWhichStub(allFound), ...darwin });
    expect(checks.find(check => check.name === 'pi')?.found).toBe('/shims/pi');
  });

  it('should populate version via the injected readVersion for found bins', async () => {
    const readVersion = async (binPath: string): Promise<string | null> => `v(${binPath})`;
    const checks = await runDoctor({ which: createWhichStub(allFound), readVersion, ...darwin });
    expect(checks.find(check => check.name === 'pi')?.version).toBe('v(/shims/pi)');
    expect(checks.find(check => check.name === 'nono')?.version).toBe('v(/shims/nono)');
    expect(checks.find(check => check.name === 'mise')?.version).toBe('v(/shims/mise)');
  });

  it('should report version: null when readVersion is absent', async () => {
    const checks = await runDoctor({ which: createWhichStub(allFound), ...darwin });
    expect(checks.every(check => check.version === null)).toBe(true);
  });

  it('should report version: null when readVersion returns null', async () => {
    const checks = await runDoctor({ which: createWhichStub(allFound), readVersion: async () => null, ...darwin });
    expect(checks.every(check => check.version === null)).toBe(true);
  });

  it('should never call readVersion for a bin that was not found', async () => {
    const calls: string[] = [];
    const readVersion = async (binPath: string): Promise<string | null> => {
      calls.push(binPath);
      return '1.0.0';
    };
    const checks = await runDoctor({ which: createWhichStub({ pi: '/shims/pi' }), readVersion, ...darwin });
    expect(calls).toEqual(['/shims/pi']);
    expect(checks.find(check => check.name === 'nono')?.version).toBeNull();
  });

  describe('scheduling-backend probe', () => {
    it('should probe launchctl on darwin', async () => {
      const checks = await runDoctor({
        which: createWhichStub({ launchctl: '/usr/bin/launchctl' }),
        platform: 'darwin'
      });
      const check = checks.find(entry => entry.name === 'launchctl');
      expect(check?.found).toBe('/usr/bin/launchctl');
      expect(check?.required).toBe(false);
    });

    it('should probe systemctl on linux', async () => {
      const checks = await runDoctor({ which: createWhichStub({}), platform: 'linux' });
      const check = checks.find(entry => entry.name === 'systemctl');
      expect(check).toBeDefined();
      expect(check?.found).toBeNull();
      expect(check?.note).toContain('systemd --user timers');
    });

    it('should skip the check entirely on a platform with neither backend', async () => {
      const checks = await runDoctor({ which: createWhichStub({}), platform: 'win32' });
      expect(checks.map(check => check.name)).toEqual(['pi', 'nono', 'sbx', 'mise']);
    });
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

  it('should omit the version column entirely when a bin exposes no version', () => {
    const report = formatDoctorReport([{ name: 'pi', bin: 'pi', required: true, found: '/shims/pi', version: null }]);
    expect(report).toContain('✓ pi       /shims/pi');
    expect(report).not.toContain('?');
  });

  it('should widen every name column to fit the longest bin name', () => {
    const report = formatDoctorReport([
      { name: 'pi', bin: 'pi', required: true, found: '/shims/pi', version: '1.2.3' },
      { name: 'launchctl', bin: 'launchctl', required: false, found: '/bin/launchctl', version: null }
    ]);
    const [piLine, launchctlLine] = report.split('\n');
    expect(piLine?.indexOf('1.2.3')).toBe(launchctlLine?.indexOf('/bin/launchctl'));
  });

  it('should leave missing-bin lines unaffected by the version column', () => {
    const report = formatDoctorReport([{ name: 'nono', bin: 'nono', required: true, found: null, version: null }]);
    expect(report).toBe('✗ nono     MISSING (required)');
  });
});
