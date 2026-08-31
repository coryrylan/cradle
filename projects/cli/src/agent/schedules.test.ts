import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadSchedules } from './schedules.js';

const HOME = homedir();

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cradle-schedules-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function addSchedule(name: string, content: string): Promise<void> {
  await writeFile(join(dir, name), content, 'utf8');
}

const validFrontmatter = ['---', "cron: '0 9 * * 1-5'", 'cwd: ~/dev/my-project', '---', 'Do the thing.', ''].join('\n');

describe('loadSchedules', () => {
  it('should return no schedules and no warnings for an empty directory', async () => {
    const result = await loadSchedules(dir, HOME);
    expect(result.schedules).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('should load a schedule with all four frontmatter keys', async () => {
    await addSchedule(
      'standup.md',
      [
        '---',
        'name: Daily standup report',
        'description: Summarize commits.',
        "cron: '0 9 * * 1-5'",
        'cwd: ~/dev/my-project',
        '---',
        '',
        'Read the git log and write a summary.',
        ''
      ].join('\n')
    );
    const result = await loadSchedules(dir, HOME);
    expect(result.warnings).toEqual([]);
    expect(result.schedules).toEqual([
      {
        slug: 'standup',
        name: 'Daily standup report',
        path: join(dir, 'standup.md'),
        cron: '0 9 * * 1-5',
        cwd: join(HOME, 'dev', 'my-project'),
        description: 'Summarize commits.',
        prompt: 'Read the git log and write a summary.'
      }
    ]);
  });

  it('should default name to the slug when name is absent', async () => {
    await addSchedule('backup.md', validFrontmatter);
    const result = await loadSchedules(dir, HOME);
    expect(result.warnings).toEqual([]);
    expect(result.schedules).toEqual([
      {
        slug: 'backup',
        name: 'backup',
        path: join(dir, 'backup.md'),
        cron: '0 9 * * 1-5',
        cwd: join(HOME, 'dev', 'my-project'),
        prompt: 'Do the thing.'
      }
    ]);
  });

  it('should expand ~ and resolve cwd', async () => {
    await addSchedule('a.md', validFrontmatter);
    const result = await loadSchedules(dir, HOME);
    expect(result.schedules[0]?.cwd).toBe(join(HOME, 'dev', 'my-project'));
  });

  it('should expand $HOME in cwd', async () => {
    await addSchedule(
      'a.md',
      ['---', "cron: '0 9 * * 1-5'", 'cwd: $HOME/dev/my-project', '---', 'Do it.', ''].join('\n')
    );
    const result = await loadSchedules(dir, HOME);
    expect(result.warnings).toEqual([]);
    expect(result.schedules[0]?.cwd).toBe(join(HOME, 'dev', 'my-project'));
  });

  it('should sort schedules by slug', async () => {
    await addSchedule('zebra.md', validFrontmatter);
    await addSchedule('alpha.md', validFrontmatter);
    await addSchedule('mid.md', validFrontmatter);
    const result = await loadSchedules(dir, HOME);
    expect(result.schedules.map(schedule => schedule.slug)).toEqual(['alpha', 'mid', 'zebra']);
  });

  it('should trim leading/trailing blank lines from the body but keep it otherwise verbatim', async () => {
    await addSchedule(
      'a.md',
      ['---', "cron: '0 9 * * 1-5'", 'cwd: ~/dev', '---', '', '', 'Line one.', 'Line two.', '', ''].join('\n')
    );
    const result = await loadSchedules(dir, HOME);
    expect(result.schedules[0]?.prompt).toBe('Line one.\nLine two.');
  });

  it('should ignore non-.md files, warning', async () => {
    await addSchedule('notes.txt', 'not a schedule');
    const result = await loadSchedules(dir, HOME);
    expect(result.schedules).toEqual([]);
    expect(result.warnings).toEqual([`${join(dir, 'notes.txt')}: only .md files are read from schedule/ — ignored`]);
  });

  it('should ignore subdirectories, warning', async () => {
    await mkdir(join(dir, 'nested'));
    const result = await loadSchedules(dir, HOME);
    expect(result.schedules).toEqual([]);
    expect(result.warnings).toEqual([
      `${join(dir, 'nested')}: subdirectories are not supported in schedule/ — ignored`
    ]);
  });

  it('should warn and drop a file with no frontmatter block', async () => {
    await addSchedule('a.md', 'Just a prompt, no frontmatter.\n');
    const result = await loadSchedules(dir, HOME);
    expect(result.schedules).toEqual([]);
    expect(result.warnings).toEqual([
      `${join(dir, 'a.md')}: missing YAML frontmatter block (a file starting with "---" and a closing "---") — ignored`
    ]);
  });

  it('should warn and drop a file whose frontmatter has no closing ---', async () => {
    await addSchedule('a.md', ['---', "cron: '0 9 * * 1-5'", 'cwd: ~/dev'].join('\n'));
    const result = await loadSchedules(dir, HOME);
    expect(result.schedules).toEqual([]);
    expect(result.warnings).toEqual([
      `${join(dir, 'a.md')}: missing YAML frontmatter block (a file starting with "---" and a closing "---") — ignored`
    ]);
  });

  it('should handle CRLF line endings in the frontmatter delimiters', async () => {
    await addSchedule('a.md', "---\r\ncron: '0 9 * * 1-5'\r\ncwd: ~/dev\r\n---\r\nDo it.\r\n");
    const result = await loadSchedules(dir, HOME);
    expect(result.warnings).toEqual([]);
    expect(result.schedules[0]?.prompt).toBe('Do it.');
  });

  it('should warn and drop a file whose YAML fails to parse', async () => {
    await addSchedule('a.md', ['---', 'cron: [unterminated', 'cwd: ~/dev', '---', 'Do it.', ''].join('\n'));
    const result = await loadSchedules(dir, HOME);
    expect(result.schedules).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(new RegExp(`^${join(dir, 'a.md')}: frontmatter is not valid YAML:`));
  });

  it('should warn and drop a file whose frontmatter does not parse to a mapping', async () => {
    await addSchedule('a.md', ['---', '- just', '- a', '- list', '---', 'Do it.', ''].join('\n'));
    const result = await loadSchedules(dir, HOME);
    expect(result.schedules).toEqual([]);
    expect(result.warnings).toEqual([`${join(dir, 'a.md')}: frontmatter must be a YAML mapping — ignored`]);
  });

  it('should warn and drop when cron is missing', async () => {
    await addSchedule('a.md', ['---', 'cwd: ~/dev', '---', 'Do it.', ''].join('\n'));
    const result = await loadSchedules(dir, HOME);
    expect(result.schedules).toEqual([]);
    expect(result.warnings).toEqual([`${join(dir, 'a.md')}: cron must be a non-empty string — ignored`]);
  });

  it('should warn and drop when cron is not a string', async () => {
    await addSchedule('a.md', ['---', 'cron: 5', 'cwd: ~/dev', '---', 'Do it.', ''].join('\n'));
    const result = await loadSchedules(dir, HOME);
    expect(result.warnings).toEqual([`${join(dir, 'a.md')}: cron must be a non-empty string — ignored`]);
  });

  it('should warn and drop when cron is empty after trimming', async () => {
    await addSchedule('a.md', ['---', "cron: '   '", 'cwd: ~/dev', '---', 'Do it.', ''].join('\n'));
    const result = await loadSchedules(dir, HOME);
    expect(result.warnings).toEqual([`${join(dir, 'a.md')}: cron must be a non-empty string — ignored`]);
  });

  it('should warn and drop when cwd is missing', async () => {
    await addSchedule('a.md', ['---', "cron: '0 9 * * 1-5'", '---', 'Do it.', ''].join('\n'));
    const result = await loadSchedules(dir, HOME);
    expect(result.warnings).toEqual([`${join(dir, 'a.md')}: cwd must be an absolute, ~/, or $HOME/ path — ignored`]);
  });

  it('should warn and drop when cwd is not path-shaped', async () => {
    await addSchedule('a.md', ['---', "cron: '0 9 * * 1-5'", 'cwd: relative/path', '---', 'Do it.', ''].join('\n'));
    const result = await loadSchedules(dir, HOME);
    expect(result.warnings).toEqual([`${join(dir, 'a.md')}: cwd must be an absolute, ~/, or $HOME/ path — ignored`]);
  });

  it('should name the YAML-null trap when cwd is a bare tilde', async () => {
    await addSchedule('a.md', ['---', "cron: '0 9 * * 1-5'", 'cwd: ~', '---', 'Do it.', ''].join('\n'));
    const result = await loadSchedules(dir, HOME);
    expect(result.warnings).toEqual([
      `${join(dir, 'a.md')}: cwd must be an absolute, ~/, or $HOME/ path ` +
        `(a bare "~" is YAML null — quote it as "~" or write ~/some/dir) — ignored`
    ]);
  });

  it('should accept a quoted tilde as the home directory', async () => {
    await addSchedule('a.md', ['---', "cron: '0 9 * * 1-5'", "cwd: '~'", '---', 'Do it.', ''].join('\n'));
    const result = await loadSchedules(dir, HOME);
    expect(result.warnings).toEqual([]);
    expect(result.schedules[0]?.cwd).toBe(HOME);
  });

  it('should warn and drop when the body is empty after trimming', async () => {
    await addSchedule('a.md', ['---', "cron: '0 9 * * 1-5'", 'cwd: ~/dev', '---', '   ', ''].join('\n'));
    const result = await loadSchedules(dir, HOME);
    expect(result.schedules).toEqual([]);
    expect(result.warnings).toEqual([
      `${join(dir, 'a.md')}: body is empty — a schedule with no prompt does nothing — ignored`
    ]);
  });

  it('should warn and drop when the slug does not match the allowed shape', async () => {
    await addSchedule('.hidden.md', validFrontmatter);
    const result = await loadSchedules(dir, HOME);
    expect(result.schedules).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(`${join(dir, '.hidden.md')}: filename must match`);
  });

  it('should warn but keep the schedule for unknown frontmatter keys', async () => {
    await addSchedule(
      'a.md',
      ['---', "cron: '0 9 * * 1-5'", 'cwd: ~/dev', 'model: opus', '---', 'Do it.', ''].join('\n')
    );
    const result = await loadSchedules(dir, HOME);
    expect(result.warnings).toEqual([`${join(dir, 'a.md')}: unsupported keys ignored: model`]);
    expect(result.schedules).toHaveLength(1);
    expect(result.schedules[0]?.cron).toBe('0 9 * * 1-5');
  });

  it('should warn but keep the schedule when name is present but not a string', async () => {
    await addSchedule('a.md', ['---', "cron: '0 9 * * 1-5'", 'cwd: ~/dev', 'name: 5', '---', 'Do it.', ''].join('\n'));
    const result = await loadSchedules(dir, HOME);
    expect(result.warnings).toEqual([`${join(dir, 'a.md')}: name must be a string — ignored`]);
    expect(result.schedules).toHaveLength(1);
    expect(result.schedules[0]?.name).toBe('a');
  });

  it('should warn but keep the schedule when description is present but not a string', async () => {
    await addSchedule(
      'a.md',
      ['---', "cron: '0 9 * * 1-5'", 'cwd: ~/dev', 'description: 5', '---', 'Do it.', ''].join('\n')
    );
    const result = await loadSchedules(dir, HOME);
    expect(result.warnings).toEqual([`${join(dir, 'a.md')}: description must be a string — ignored`]);
    expect(result.schedules).toHaveLength(1);
    expect(result.schedules[0]?.description).toBeUndefined();
  });

  it('should not stop other schedules from loading when one is malformed', async () => {
    await addSchedule('bad.md', 'no frontmatter here\n');
    await addSchedule('good.md', validFrontmatter);
    const result = await loadSchedules(dir, HOME);
    expect(result.schedules.map(schedule => schedule.slug)).toEqual(['good']);
    expect(result.warnings).toHaveLength(1);
  });

  it('should follow a symlinked .md file so schedules can be shared between agents', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cradle-schedules-outside-'));
    try {
      await writeFile(join(outside, 'shared.md'), validFrontmatter, 'utf8');
      await symlink(join(outside, 'shared.md'), join(dir, 'linked.md'));
      const result = await loadSchedules(dir, HOME);
      expect(result.schedules.map(schedule => schedule.slug)).toEqual(['linked']);
      expect(result.warnings).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('should warn, not silently drop, when a broken symlink cannot be read', async () => {
    await symlink(join(dir, 'does-not-exist.md'), join(dir, 'dangling.md'));
    await writeFile(join(dir, 'good.md'), validFrontmatter, 'utf8');
    const result = await loadSchedules(dir, HOME);
    expect(result.schedules.map(schedule => schedule.slug)).toEqual(['good']);
    // Silence would make the schedule vanish from list and install with
    // nothing to explain the absence.
    expect(result.warnings).toEqual([`${join(dir, 'dangling.md')}: could not be read — broken symlink? — ignored`]);
  });
});
