import { describe, expect, it } from 'bun:test';

import type { CronFields } from './cron.js';
import { LaunchdIntervalOverflowError, composeLaunchdTimer } from './launchd.js';
import type { TimerContext } from './timer.js';

const EVERY: CronFields = { minute: null, hour: null, dayOfMonth: null, month: null, dayOfWeek: null };

function timerContext(overrides: Partial<TimerContext> = {}): TimerContext {
  return {
    schedule: {
      slug: 'nightly-report',
      name: 'Nightly Report',
      path: '/agents/reporter/schedule/nightly-report.md',
      cron: '0 9 * * 1-5',
      cwd: '/work/project',
      prompt: 'Summarize yesterday.'
    },
    agentId: 'reporter-a1b2c3d4',
    agentDir: '/agents/reporter',
    cradleBin: '/home/u/.local/bin/cradle',
    logPath: '/home/u/.cradle/agents/reporter-a1b2c3d4/schedule/nightly-report.log',
    home: '/home/u',
    uid: 501,
    ...overrides
  };
}

/** Test-only XML scraper — the emitter itself is a dependency-free string composer, not a parser. */
function extractCalendarDicts(plist: string): readonly Record<string, number>[] {
  const section = /<key>StartCalendarInterval<\/key>\s*<array>([\s\S]*?)\n {2}<\/array>/.exec(plist);
  if (section?.[1] === undefined) throw new Error('StartCalendarInterval array not found');
  const dictBodies = [...section[1].matchAll(/<dict>([\s\S]*?)<\/dict>/g)].map(match => match[1] ?? '');
  return dictBodies.map(body => {
    const entries = [...body.matchAll(/<key>(\w+)<\/key>\s*<integer>(\d+)<\/integer>/g)];
    return Object.fromEntries(entries.map(entry => [entry[1], Number(entry[2])]));
  });
}

describe('composeLaunchdTimer', () => {
  describe('StartCalendarInterval expansion', () => {
    const cases: readonly (readonly [string, CronFields, readonly Record<string, number>[]])[] = [
      ['minute + hour', { ...EVERY, minute: [0], hour: [9] }, [{ Minute: 0, Hour: 9 }]],
      [
        'minute list',
        { ...EVERY, minute: [0, 15, 30, 45] },
        [{ Minute: 0 }, { Minute: 15 }, { Minute: 30 }, { Minute: 45 }]
      ],
      [
        'minute + hour + weekday list',
        { ...EVERY, minute: [0], hour: [9], dayOfWeek: [1, 2, 3, 4, 5] },
        [1, 2, 3, 4, 5].map(weekday => ({ Minute: 0, Hour: 9, Weekday: weekday }))
      ],
      ['all fields every', EVERY, Array.from({ length: 60 }, (_unused, minute) => ({ Minute: minute }))]
    ];

    it.each(cases)('should expand %s into the matching dicts', (_label, fields, expectedDicts) => {
      const plan = composeLaunchdTimer(timerContext(), fields);
      expect(extractCalendarDicts(plan.files[0]?.content ?? '')).toEqual(expectedDicts);
    });
  });

  describe('500-dict cap', () => {
    it('should throw LaunchdIntervalOverflowError past the cap', () => {
      const minute = Array.from({ length: 59 }, (_unused, index) => index);
      const hour = Array.from({ length: 23 }, (_unused, index) => index);
      const fields: CronFields = { ...EVERY, minute, hour };
      expect(() => composeLaunchdTimer(timerContext(), fields)).toThrow(LaunchdIntervalOverflowError);
      expect(() => composeLaunchdTimer(timerContext(), fields)).toThrow(/1357.*500-dict cap/);
    });

    it('should not throw exactly at the cap', () => {
      const minute = Array.from({ length: 50 }, (_unused, index) => index);
      const hour = Array.from({ length: 10 }, (_unused, index) => index);
      const fields: CronFields = { ...EVERY, minute, hour };
      expect(() => composeLaunchdTimer(timerContext(), fields)).not.toThrow();
    });
  });

  describe('XML escaping', () => {
    it('should escape & before < and >', () => {
      const context = timerContext({ schedule: { ...timerContext().schedule, cwd: '/work/A&B<C>' } });
      const plan = composeLaunchdTimer(context, { ...EVERY, minute: [0] });
      expect(plan.files[0]?.content).toContain('<string>/work/A&amp;B&lt;C&gt;</string>');
      expect(plan.files[0]?.content).not.toContain('A&amp;amp;');
    });

    it('should round-trip a path containing &', () => {
      const context = timerContext({ logPath: '/logs/a&b.log' });
      const plan = composeLaunchdTimer(context, { ...EVERY, minute: [0] });
      expect(plan.files[0]?.content).toContain('<string>/logs/a&amp;b.log</string>');
    });
  });

  describe('all-wildcard expansion', () => {
    it('should spell out every minute rather than emit a keyless dict', () => {
      const plan = composeLaunchdTimer(timerContext(), EVERY);
      const dicts = extractCalendarDicts(plan.files[0]?.content ?? '');
      // A keyless <dict/> is not launchd's documented wildcard form and may
      // never fire, so `* * * * *` states its 60 minutes explicitly.
      expect(dicts).toHaveLength(60);
      expect(dicts[0]).toEqual({ Minute: 0 });
      expect(dicts[59]).toEqual({ Minute: 59 });
      expect(plan.files[0]?.content).not.toContain('<dict>\n\n');
    });
  });

  describe('plan shape', () => {
    it('should derive the label, plist path, and file content', () => {
      const plan = composeLaunchdTimer(timerContext(), {
        ...EVERY,
        minute: [0],
        hour: [9],
        dayOfWeek: [1, 2, 3, 4, 5]
      });
      expect(plan.id).toBe('com.cradle.reporter-a1b2c3d4.nightly-report');
      expect(plan.files).toHaveLength(1);
      expect(plan.files[0]?.path).toBe(
        '/home/u/Library/LaunchAgents/com.cradle.reporter-a1b2c3d4.nightly-report.plist'
      );
      expect(plan.files[0]?.content).toContain('<key>Label</key>');
      expect(plan.files[0]?.content).toContain('<string>com.cradle.reporter-a1b2c3d4.nightly-report</string>');
      expect(plan.files[0]?.content).toContain(
        // The timer is the only caller of `cradle schedule run`; this argv is
        // the contract that let the overlapping `cradle run --schedule` go.
        '<array>\n    <string>/home/u/.local/bin/cradle</string>\n    <string>schedule</string>\n    ' +
          '<string>run</string>\n    <string>/agents/reporter</string>\n    ' +
          '<string>nightly-report</string>\n  </array>'
      );
      expect(plan.files[0]?.content).toContain('<key>WorkingDirectory</key>\n  <string>/work/project</string>');
      expect(plan.files[0]?.content).toContain('<false/>');
      expect(plan.files[0]?.content).toContain('<string>Background</string>');
    });

    it('should compose the PATH from home plus the fixed system directories', () => {
      const plan = composeLaunchdTimer(timerContext(), { ...EVERY, minute: [0] });
      expect(plan.files[0]?.content).toContain(
        '<string>/home/u/.local/bin:/home/u/.local/share/mise/shims:/opt/homebrew/bin:' +
          '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>'
      );
    });

    it('should compose install/remove steps against gui/<uid>/<label>', () => {
      const plan = composeLaunchdTimer(timerContext(), { ...EVERY, minute: [0] });
      const label = 'com.cradle.reporter-a1b2c3d4.nightly-report';
      const target = `gui/501/${label}`;
      expect(plan.installSteps).toEqual([
        { argv: ['launchctl', 'bootout', target], ignoreFailure: true },
        { argv: ['launchctl', 'bootstrap', 'gui/501', `/home/u/Library/LaunchAgents/${label}.plist`] },
        { argv: ['launchctl', 'enable', target] }
      ]);
      expect(plan.removeSteps).toEqual([{ argv: ['launchctl', 'bootout', target], ignoreFailure: true }]);
    });
  });
});
