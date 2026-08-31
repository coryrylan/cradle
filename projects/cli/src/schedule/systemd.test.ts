import { describe, expect, it } from 'bun:test';

import type { CronFields } from './cron.js';
import { LINGER_HINT, SystemdUnitValueError, composeLingerCheckArgv, composeSystemdTimer } from './systemd.js';
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

function onCalendarLine(content: string): string | undefined {
  return content
    .split('\n')
    .find(line => line.startsWith('OnCalendar='))
    ?.slice('OnCalendar='.length);
}

describe('composeSystemdTimer', () => {
  describe('OnCalendar= translation', () => {
    const cases: readonly (readonly [string, CronFields, string])[] = [
      ['minute + hour', { ...EVERY, minute: [0], hour: [9] }, '*-*-* 09:00:00'],
      ['minute list, every hour', { ...EVERY, minute: [0, 15, 30, 45] }, '*-*-* *:00,15,30,45:00'],
      [
        'minute + hour + weekday list',
        { ...EVERY, minute: [0], hour: [9], dayOfWeek: [1, 2, 3, 4, 5] },
        'Mon,Tue,Wed,Thu,Fri *-*-* 09:00:00'
      ],
      ['all fields every', EVERY, '*-*-* *:*:00']
    ];

    it.each(cases)('should render %s as "%s"', (_label, fields, expected) => {
      const plan = composeSystemdTimer(timerContext(), fields);
      const timerFile = plan.files.find(file => file.path.endsWith('.timer'));
      expect(onCalendarLine(timerFile?.content ?? '')).toBe(expected);
    });

    it('should zero-pad single-digit day-of-month and month values', () => {
      const plan = composeSystemdTimer(timerContext(), {
        ...EVERY,
        minute: [0],
        hour: [0],
        dayOfMonth: [1],
        month: [1]
      });
      const timerFile = plan.files.find(file => file.path.endsWith('.timer'));
      expect(onCalendarLine(timerFile?.content ?? '')).toBe('*-01-01 00:00:00');
    });
  });

  describe('escaping', () => {
    it('should double a literal % in a unit value', () => {
      const context = timerContext({ schedule: { ...timerContext().schedule, name: 'Nightly 100% Report' } });
      const plan = composeSystemdTimer(context, { ...EVERY, minute: [0] });
      expect(plan.files[0]?.content).toContain('Description=Nightly 100%% Report');
    });

    it('should reject a newline in the schedule name with a named error', () => {
      const context = timerContext({ schedule: { ...timerContext().schedule, name: 'bad\nname' } });
      expect(() => composeSystemdTimer(context, { ...EVERY, minute: [0] })).toThrow(SystemdUnitValueError);
    });

    it('should reject a newline in the cwd with a named error', () => {
      const context = timerContext({ schedule: { ...timerContext().schedule, cwd: '/work/bad\npath' } });
      expect(() => composeSystemdTimer(context, { ...EVERY, minute: [0] })).toThrow(SystemdUnitValueError);
    });

    it('should set an explicit PATH, since the user manager default omits ~/.local/bin', () => {
      const plan = composeSystemdTimer(timerContext(), { ...EVERY, minute: [0] });
      // Mirrors launchd's plist PATH — without it the same schedule resolves
      // tools differently on Linux than on macOS.
      expect(plan.files[0]?.content).toContain(
        'Environment=PATH=/home/u/.local/bin:/home/u/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
      );
    });

    it('should invoke `cradle schedule run` — the only entry point a timer uses', () => {
      const plan = composeSystemdTimer(timerContext(), { ...EVERY, minute: [0] });
      expect(plan.files[0]?.content).toContain(
        'ExecStart="/home/u/.local/bin/cradle" "schedule" "run" "/agents/reporter" "nightly-report"'
      );
    });

    it('should quote an agent dir containing a space so ExecStart does not split it', () => {
      const context = timerContext({ agentDir: '/agents/My Reporter' });
      const plan = composeSystemdTimer(context, { ...EVERY, minute: [0] });
      expect(plan.files[0]?.content).toContain('"/agents/My Reporter" "nightly-report"');
    });

    it('should escape a quote and a backslash inside an ExecStart argument', () => {
      const context = timerContext({ agentDir: '/agents/a"b\\c' });
      const plan = composeSystemdTimer(context, { ...EVERY, minute: [0] });
      expect(plan.files[0]?.content).toContain('"/agents/a\\"b\\\\c"');
    });

    it('should leave WorkingDirectory unquoted, since systemd takes the rest of the line verbatim', () => {
      const context = timerContext({ schedule: { ...timerContext().schedule, cwd: '/work/My Project' } });
      const plan = composeSystemdTimer(context, { ...EVERY, minute: [0] });
      expect(plan.files[0]?.content).toContain('WorkingDirectory=/work/My Project\n');
    });
  });

  describe('plan shape', () => {
    it('should derive the unit base name, file paths, and unit content', () => {
      const plan = composeSystemdTimer(timerContext(), { ...EVERY, minute: [0], hour: [9] });
      expect(plan.id).toBe('cradle-reporter-a1b2c3d4-nightly-report');
      expect(plan.files).toHaveLength(2);
      expect(plan.files[0]?.path).toBe('/home/u/.config/systemd/user/cradle-reporter-a1b2c3d4-nightly-report.service');
      expect(plan.files[1]?.path).toBe('/home/u/.config/systemd/user/cradle-reporter-a1b2c3d4-nightly-report.timer');
    });

    it('should compose the .service unit', () => {
      const plan = composeSystemdTimer(timerContext(), { ...EVERY, minute: [0], hour: [9] });
      expect(plan.files[0]?.content).toBe(
        [
          '[Unit]',
          'Description=Nightly Report',
          '',
          '[Service]',
          'Type=oneshot',
          'WorkingDirectory=/work/project',
          'Environment=PATH=/home/u/.local/bin:/home/u/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
          'ExecStart="/home/u/.local/bin/cradle" "schedule" "run" "/agents/reporter" "nightly-report"',
          'StandardOutput=append:/home/u/.cradle/agents/reporter-a1b2c3d4/schedule/nightly-report.log',
          'StandardError=append:/home/u/.cradle/agents/reporter-a1b2c3d4/schedule/nightly-report.log',
          ''
        ].join('\n')
      );
    });

    it('should compose the .timer unit', () => {
      const plan = composeSystemdTimer(timerContext(), { ...EVERY, minute: [0], hour: [9] });
      expect(plan.files[1]?.content).toBe(
        [
          '[Unit]',
          'Description=Nightly Report',
          '',
          '[Timer]',
          'OnCalendar=*-*-* 09:00:00',
          'Persistent=true',
          '',
          '[Install]',
          'WantedBy=timers.target',
          ''
        ].join('\n')
      );
    });

    it('should compose install/remove steps against systemctl --user', () => {
      const plan = composeSystemdTimer(timerContext(), { ...EVERY, minute: [0] });
      const base = 'cradle-reporter-a1b2c3d4-nightly-report';
      expect(plan.installSteps).toEqual([
        { argv: ['systemctl', '--user', 'daemon-reload'] },
        { argv: ['systemctl', '--user', 'enable', '--now', `${base}.timer`] }
      ]);
      expect(plan.removeSteps).toEqual([
        { argv: ['systemctl', '--user', 'disable', '--now', `${base}.timer`], ignoreFailure: true },
        { argv: ['systemctl', '--user', 'daemon-reload'] }
      ]);
    });
  });
});

describe('composeLingerCheckArgv', () => {
  it('should compose the loginctl property lookup', () => {
    expect(composeLingerCheckArgv('cory')).toEqual(['loginctl', 'show-user', 'cory', '--property=Linger']);
  });
});

describe('LINGER_HINT', () => {
  it('should mention loginctl enable-linger', () => {
    expect(LINGER_HINT).toContain('loginctl enable-linger');
  });
});
