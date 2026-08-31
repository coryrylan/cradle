import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { exists, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWhichStub, type WhichFn } from '../util/which.js';
import { formatScheduleList, materializeSchedule, planSchedule, type ScheduleRunResult } from './schedule.js';

let root: string;
let agentDir: string;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cradle-schedule-'));
  agentDir = join(root, 'my-agent');
  home = join(root, 'home');
  await mkdir(agentDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(agentDir, 'APPEND_SYSTEM.md'), '# Role\n', 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function addSchedule(name: string, frontmatter: Record<string, string>, prompt: string): Promise<void> {
  const path = join(agentDir, 'schedule', name);
  await mkdir(join(path, '..'), { recursive: true });
  const lines = [
    '---',
    ...Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`),
    '---',
    '',
    prompt,
    ''
  ];
  await writeFile(path, lines.join('\n'), 'utf8');
}

const which = createWhichStub({ cradle: '/shims/cradle' });
const now = (): Date => new Date('2030-01-01T00:00:00');

interface DepsOverrides {
  readonly which?: WhichFn;
  readonly user?: string;
}

// Functions, not module-level consts — `home` is only assigned once
// `beforeEach` runs, so a const built at module-eval time would freeze the
// pre-test (undefined) value instead of picking up each test's temp dir.
function darwinDeps(overrides: DepsOverrides = {}) {
  return { home, which, platform: 'darwin' as const, uid: 501, now, ...overrides };
}

function linuxDeps(overrides: DepsOverrides = {}) {
  return { home, which, platform: 'linux' as const, uid: 1000, now, ...overrides };
}

function okRunner(): (argv: readonly string[]) => Promise<ScheduleRunResult> {
  return async () => ({ exitCode: 0, stdout: '', stderr: '' });
}

describe('planSchedule', () => {
  it('should throw naming the folder when schedule/ is absent', async () => {
    await expect(planSchedule({ dir: agentDir, action: 'list' }, darwinDeps())).rejects.toThrow(
      `No schedule/ directory in ${agentDir}`
    );
  });

  it('should name the singular rename when the folder has a plural schedules/ instead', async () => {
    await mkdir(join(agentDir, 'schedules'), { recursive: true });
    await expect(planSchedule({ dir: agentDir, action: 'list' }, darwinDeps())).rejects.toThrow(
      `No schedule/ directory in ${agentDir} — found schedules/, rename it to schedule/ (singular)`
    );
  });

  it('should throw the unsupported-platform error and never reach the folder for a platform with no timer backend', async () => {
    await expect(planSchedule({ dir: agentDir, action: 'list' }, { home, which, platform: 'win32' })).rejects.toThrow(
      'Scheduled tasks are not supported on win32 — launchd (macOS) and systemd (Linux) are the supported timer backends'
    );
  });

  it('should resolve a bare name through the global alias table, like `cradle run` does', async () => {
    await addSchedule('nightly.md', { name: 'Nightly', cwd: root, cron: "'0 9 * * *'" }, 'Do it.');
    await mkdir(join(home, '.cradle'), { recursive: true });
    await writeFile(
      join(home, '.cradle', 'settings.json'),
      JSON.stringify({ agents: { assistant: { path: agentDir } } }),
      'utf8'
    );
    // cwd deliberately has no `./assistant` directory, so this can only resolve via the alias table.
    const plan = await planSchedule({ dir: 'assistant', action: 'install' }, { ...darwinDeps(), cwd: root });
    expect(plan.folder.dir).toBe(agentDir);
  });

  it("should record the alias's resolved absolute path in the timer, not the alias name", async () => {
    await addSchedule('nightly.md', { name: 'Nightly', cwd: root, cron: "'0 9 * * *'" }, 'Do it.');
    await mkdir(join(home, '.cradle'), { recursive: true });
    await writeFile(
      join(home, '.cradle', 'settings.json'),
      JSON.stringify({ agents: { assistant: { path: agentDir } } }),
      'utf8'
    );
    const plan = await planSchedule({ dir: 'assistant', action: 'install' }, { ...darwinDeps(), cwd: root });
    // An installed timer must survive the alias being renamed or deleted.
    const plist = plan.targets[0]?.timerPlan.files[0]?.content ?? '';
    expect(plist).toContain(`<string>${agentDir}</string>`);
    expect(plist).not.toContain('<string>assistant</string>');
  });

  it('should default uid to process.getuid() when not injected', async () => {
    await addSchedule('nightly.md', { name: 'Nightly', cwd: root, cron: "'0 9 * * *'" }, 'Do it.');
    const plan = await planSchedule({ dir: agentDir, action: 'install' }, { home, which, platform: 'darwin' });
    expect(plan.targets[0]?.timerPlan.id).toContain('nightly');
  });

  describe('list', () => {
    beforeEach(async () => {
      await addSchedule(
        'nightly.md',
        { name: 'Nightly report', cwd: join(root, 'work'), cron: "'0 9 * * *'" },
        'Summarize.'
      );
      await mkdir(join(root, 'work'), { recursive: true });
    });

    it('should list every schedule with cron/cwd/next-fire and installed: false before install', async () => {
      const plan = await planSchedule({ dir: agentDir, action: 'list' }, darwinDeps());
      expect(plan.rows).toHaveLength(1);
      const [row] = plan.rows;
      expect(row?.slug).toBe('nightly');
      expect(row?.name).toBe('Nightly report');
      expect(row?.cwd).toBe(join(root, 'work'));
      expect(row?.installed).toBe(false);
      expect(row?.nextFire).not.toBeNull();
      expect(row?.cronError).toBeUndefined();
    });

    it('should never call requireBin("cradle") for list — no bin is needed to read schedules', async () => {
      const throwingWhich = (): never => {
        throw new Error('Which must not be called for list');
      };
      await expect(
        planSchedule({ dir: agentDir, action: 'list' }, darwinDeps({ which: throwingWhich }))
      ).resolves.toBeDefined();
    });

    it('should still list a schedule whose cron overflows the launchd dict cap, instead of aborting', async () => {
      // 59 x 23 = 1357 dicts, over the 500 cap: the emitter throws, and that
      // must land in this row rather than hiding every other schedule.
      await addSchedule('huge.md', { name: 'Huge', cwd: join(root, 'work'), cron: "'1-59 1-23 * * *'" }, 'Do it.');
      const plan = await planSchedule({ dir: agentDir, action: 'list' }, darwinDeps());
      expect(plan.rows.map(row => row.slug).sort()).toEqual(['huge', 'nightly']);
      expect(plan.rows.find(row => row.slug === 'huge')?.cronError).toContain('over the 500-dict cap');
      expect(plan.rows.find(row => row.slug === 'nightly')?.cronError).toBeUndefined();
    });

    it('should still list a schedule whose name breaks the systemd unit syntax', async () => {
      // Double-quoted YAML, so `\n` is a real newline in the parsed value — the
      // only way a name can reach the systemd emitter and trip its unit-value guard.
      await addSchedule('bad.md', { name: '"line\\nbreak"', cwd: join(root, 'work'), cron: "'0 9 * * *'" }, 'Do it.');
      const plan = await planSchedule({ dir: agentDir, action: 'list' }, linuxDeps());
      expect(plan.rows.map(row => row.slug).sort()).toEqual(['bad', 'nightly']);
      expect(plan.rows.find(row => row.slug === 'bad')?.cronError).toContain('newline');
    });

    it('should still list a schedule with an unparseable cron, reporting the error instead of aborting', async () => {
      await addSchedule('broken.md', { name: 'Broken', cwd: join(root, 'work'), cron: "'99 * * * *'" }, 'Do it.');
      const plan = await planSchedule({ dir: agentDir, action: 'list' }, darwinDeps());
      expect(plan.rows).toHaveLength(2);
      const broken = plan.rows.find(row => row.slug === 'broken');
      expect(broken?.cronError).toContain('Invalid cron expression');
      expect(broken?.nextFire).toBeNull();
      expect(broken?.installed).toBe(false);
      // The other, valid schedule is unaffected.
      expect(plan.rows.find(row => row.slug === 'nightly')?.cronError).toBeUndefined();
    });

    it('should report installed: true once the timer files exist on disk (darwin)', async () => {
      const installPlan = await planSchedule({ dir: agentDir, action: 'install' }, darwinDeps());
      await materializeSchedule(installPlan, { run: okRunner() });
      const listPlan = await planSchedule({ dir: agentDir, action: 'list' }, darwinDeps());
      expect(listPlan.rows[0]?.installed).toBe(true);
    });

    it('should format an empty list distinctly', () => {
      expect(formatScheduleList([])).toBe('No schedules found.');
    });

    it('should format a row with slug, name, cron, cwd, and timer status', async () => {
      const plan = await planSchedule({ dir: agentDir, action: 'list' }, darwinDeps());
      const report = formatScheduleList(plan.rows);
      expect(report).toContain('nightly — Nightly report');
      expect(report).toContain('0 9 * * *');
      expect(report).toContain(join(root, 'work'));
      expect(report).toContain('not installed');
    });

    it('should format an invalid cron row without throwing', async () => {
      await addSchedule('broken.md', { name: 'Broken', cwd: join(root, 'work'), cron: "'99 * * * *'" }, 'Do it.');
      const plan = await planSchedule({ dir: agentDir, action: 'list' }, darwinDeps());
      expect(formatScheduleList(plan.rows)).toContain('INVALID');
    });
  });

  describe('slug selection', () => {
    beforeEach(async () => {
      await addSchedule('nightly.md', { name: 'Nightly', cwd: root, cron: "'0 9 * * *'" }, 'Do it.');
    });

    it('should throw naming the requested slug and listing available ones when install/remove/run pass an unknown slug', async () => {
      await expect(planSchedule({ dir: agentDir, action: 'install', slug: 'nope' }, darwinDeps())).rejects.toThrow(
        'Unknown schedule "nope" (available: nightly)'
      );
    });

    it('should select every schedule for `install`/`remove` when no slug is given', async () => {
      await addSchedule('weekly.md', { name: 'Weekly', cwd: root, cron: "'0 9 * * 0'" }, 'Do it too.');
      const plan = await planSchedule({ dir: agentDir, action: 'install' }, darwinDeps());
      expect(plan.targets.map(target => target.schedule.slug).sort()).toEqual(['nightly', 'weekly']);
    });

    it('should select only the matching schedule when a slug is given', async () => {
      await addSchedule('weekly.md', { name: 'Weekly', cwd: root, cron: "'0 9 * * 0'" }, 'Do it too.');
      const plan = await planSchedule({ dir: agentDir, action: 'install', slug: 'nightly' }, darwinDeps());
      expect(plan.targets.map(target => target.schedule.slug)).toEqual(['nightly']);
    });
  });

  describe('platform dispatch', () => {
    beforeEach(async () => {
      await addSchedule('nightly.md', { name: 'Nightly', cwd: root, cron: "'0 9 * * *'" }, 'Do it.');
    });

    it('should compose a launchd plist target on darwin', async () => {
      const plan = await planSchedule({ dir: agentDir, action: 'install' }, darwinDeps());
      const [target] = plan.targets;
      expect(target?.timerPlan.files[0]?.path).toContain('Library/LaunchAgents');
      expect(target?.timerPlan.installSteps[0]?.argv[0]).toBe('launchctl');
    });

    it('should compose a systemd unit pair target on linux', async () => {
      const plan = await planSchedule({ dir: agentDir, action: 'install' }, linuxDeps());
      const [target] = plan.targets;
      expect(target?.timerPlan.files).toHaveLength(2);
      expect(target?.timerPlan.files.every(file => file.path.includes('.config/systemd/user'))).toBe(true);
      expect(target?.timerPlan.installSteps[0]?.argv[0]).toBe('systemctl');
    });
  });

  describe('dry-run', () => {
    it('should skip the "cradle" bin check on --dry-run, like planRun does, and preview with the bare name', async () => {
      await addSchedule('nightly.md', { name: 'Nightly', cwd: root, cron: "'0 9 * * *'" }, 'Do it.');
      const throwingWhich = (): never => {
        throw new Error('Which must not be called on dry-run');
      };
      const plan = await planSchedule(
        { dir: agentDir, action: 'install', dryRun: true },
        darwinDeps({ which: throwingWhich })
      );
      expect(plan.dryRun).toBe(true);
      const content = plan.targets[0]?.timerPlan.files[0]?.content ?? '';
      expect(content).toContain('<string>cradle</string>');
      expect(content).not.toContain('/shims/cradle');
    });
  });

  describe('linger check (linux install)', () => {
    beforeEach(async () => {
      await addSchedule('nightly.md', { name: 'Nightly', cwd: root, cron: "'0 9 * * *'" }, 'Do it.');
    });

    it('should compose the linger-check argv only for install on linux', async () => {
      const installPlan = await planSchedule({ dir: agentDir, action: 'install' }, linuxDeps({ user: 'alice' }));
      expect(installPlan.lingerCheckArgv).toEqual(['loginctl', 'show-user', 'alice', '--property=Linger']);

      const listPlan = await planSchedule({ dir: agentDir, action: 'list' }, linuxDeps());
      expect(listPlan.lingerCheckArgv).toBeNull();

      const removePlan = await planSchedule({ dir: agentDir, action: 'remove' }, linuxDeps());
      expect(removePlan.lingerCheckArgv).toBeNull();

      const darwinInstallPlan = await planSchedule({ dir: agentDir, action: 'install' }, darwinDeps());
      expect(darwinInstallPlan.lingerCheckArgv).toBeNull();
    });
  });
});

describe('materializeSchedule', () => {
  it('should refuse a --dry-run plan outright, since remove is unrecoverable', async () => {
    await addSchedule('nightly.md', { name: 'Nightly', cwd: root, cron: "'0 9 * * *'" }, 'Do it.');
    const plan = await planSchedule({ dir: agentDir, action: 'remove', dryRun: true }, darwinDeps());
    await expect(materializeSchedule(plan, { run: okRunner() })).rejects.toThrow('preview only');
  });

  it('should not delete timer files or run any step for a --dry-run remove', async () => {
    await addSchedule('nightly.md', { name: 'Nightly', cwd: root, cron: "'0 9 * * *'" }, 'Do it.');
    const installed = await planSchedule({ dir: agentDir, action: 'install' }, darwinDeps());
    await materializeSchedule(installed, { run: okRunner() });
    const plist = installed.targets[0]?.timerPlan.files[0]?.path ?? '';
    expect(await exists(plist)).toBe(true);

    const preview = await planSchedule({ dir: agentDir, action: 'remove', dryRun: true }, darwinDeps());
    const ran: string[] = [];
    await expect(
      materializeSchedule(preview, {
        run: async argv => {
          ran.push(argv.join(' '));
          return { exitCode: 0, stdout: '', stderr: '' };
        }
      })
    ).rejects.toThrow();
    expect(ran).toEqual([]);
    expect(await exists(plist)).toBe(true);
  });

  beforeEach(async () => {
    await addSchedule('nightly.md', { name: 'Nightly', cwd: root, cron: "'0 9 * * *'" }, 'Summarize.');
  });

  it('should write every timer file and run installSteps in order', async () => {
    const plan = await planSchedule({ dir: agentDir, action: 'install' }, darwinDeps());
    const calls: (readonly string[])[] = [];
    await materializeSchedule(plan, {
      run: async argv => {
        calls.push(argv);
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    });
    const [target] = plan.targets;
    const [file] = target?.timerPlan.files ?? [];
    const installSteps = target?.timerPlan.installSteps ?? [];
    expect(file).toBeDefined();
    expect(await exists(file?.path ?? '')).toBe(true);
    expect((await readFile(file?.path ?? '', 'utf8')).length).toBeGreaterThan(0);
    expect(calls.map(argv => argv[0])).toEqual(installSteps.map(step => step.argv[0]));
  });

  it('should mkdir -p the log directory before running installSteps', async () => {
    const plan = await planSchedule({ dir: agentDir, action: 'install' }, darwinDeps());
    await materializeSchedule(plan, { run: okRunner() });
    const [target] = plan.targets;
    expect(await exists(join(target?.logPath.replace(/[^/]+$/, '') ?? ''))).toBe(true);
  });

  it('should honor ignoreFailure and not throw when an ignorable step fails', async () => {
    const plan = await planSchedule({ dir: agentDir, action: 'install' }, darwinDeps());
    // launchd's first install step (`launchctl bootout`) is `ignoreFailure: true`.
    await expect(
      materializeSchedule(plan, {
        run: async argv => ({ exitCode: argv[1] === 'bootout' ? 1 : 0, stdout: '', stderr: 'boom' })
      })
    ).resolves.toBeDefined();
  });

  it('should throw a named error when a non-ignorable step fails', async () => {
    const plan = await planSchedule({ dir: agentDir, action: 'install' }, darwinDeps());
    await expect(
      materializeSchedule(plan, {
        run: async argv => ({ exitCode: argv[1] === 'bootstrap' ? 1 : 0, stdout: '', stderr: 'boom' })
      })
    ).rejects.toThrow(/Failed to install schedule "nightly".*boom/);
  });

  it('should throw when install/remove needs a runner but none was provided', async () => {
    const plan = await planSchedule({ dir: agentDir, action: 'install' }, darwinDeps());
    await expect(materializeSchedule(plan, {})).rejects.toThrow('command runner');
  });

  it('should warn with LINGER_HINT on linux install when lingering is off', async () => {
    const plan = await planSchedule({ dir: agentDir, action: 'install' }, linuxDeps({ user: 'alice' }));
    const result = await materializeSchedule(plan, {
      run: async argv => ({ exitCode: 0, stdout: argv[0] === 'loginctl' ? 'Linger=no\n' : '', stderr: '' })
    });
    expect(result.warnings.join('\n')).toContain('loginctl enable-linger');
  });

  it('should not warn when lingering is already on', async () => {
    const plan = await planSchedule({ dir: agentDir, action: 'install' }, linuxDeps({ user: 'alice' }));
    const result = await materializeSchedule(plan, {
      run: async argv => ({ exitCode: 0, stdout: argv[0] === 'loginctl' ? 'Linger=yes\n' : '', stderr: '' })
    });
    expect(result.warnings).toEqual([]);
  });

  it('should run removeSteps and delete the timer files', async () => {
    const installPlan = await planSchedule({ dir: agentDir, action: 'install' }, darwinDeps());
    await materializeSchedule(installPlan, { run: okRunner() });
    const [target] = installPlan.targets;
    const [file] = target?.timerPlan.files ?? [];
    expect(await exists(file?.path ?? '')).toBe(true);

    const removePlan = await planSchedule({ dir: agentDir, action: 'remove' }, darwinDeps());
    await materializeSchedule(removePlan, { run: okRunner() });
    expect(await exists(file?.path ?? '')).toBe(false);
  });
});
