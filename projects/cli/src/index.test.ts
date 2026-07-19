import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import { chmod, exists, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PKG_ROOT = resolve(import.meta.dirname, '..');

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const proc = Bun.spawn(['bun', 'src/index.ts', ...args], {
    cwd: PKG_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env }
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe('start command', () => {
  let root: string;
  let agentDir: string;
  let env: Record<string, string>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cradle-smoke-'));
    agentDir = join(root, 'hello');
    env = { CRADLE_STATE_DIR: join(root, 'state') };
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'APPEND_SYSTEM.md'), '# Hello\n', 'utf8');
    await mkdir(join(agentDir, 'sandbox'), { recursive: true });
    await writeFile(join(agentDir, 'sandbox', 'nono.json'), '{}');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('prints the write plan and the composed nono command on --dry-run without needing bins', async () => {
    await writeFile(
      join(agentDir, 'models.json'),
      JSON.stringify({ providers: { ollama: { baseUrl: 'http://x/v1' } } })
    );
    const { stdout, exitCode } = await runCli(['start', agentDir, '--dry-run'], env);
    const lines = stdout.trim().split('\n');
    expect(lines.some(line => line.startsWith('write: ') && line.endsWith('providers.ts'))).toBe(true);
    expect(lines.some(line => line.startsWith('write: ') && line.endsWith('nono-profile.json'))).toBe(true);
    const command = lines.at(-1) ?? '';
    // The wrapper points nono at the generated per-agent profile; grants live inside it, not as flags.
    // --silent suppresses nono's startup banner by default. The dry-run print
    // discloses the spawn env too — cradle's one env-var exception (see
    // `agent/launch.ts`'s `composeEnv`) — as a leading shell-assignment.
    expect(command.startsWith('MISE_CACHE_DIR=')).toBe(true);
    expect(command).toContain('/mise-cache nono run --silent --profile ');
    expect(command).toContain('nono-profile.json');
    expect(command).not.toContain('--allow ');
    expect(command).not.toContain('--read ');
    expect(command).toContain(`--append-system-prompt ${join(agentDir, 'APPEND_SYSTEM.md')}`);
    expect(command).toContain('-e ');
    expect(command).toContain('--session-dir');
    expect(exitCode).toBe(0);
  });

  it('should fall back to bare pi and warn when sandbox/nono.json is absent', async () => {
    await rm(join(agentDir, 'sandbox'), { recursive: true });
    const { stdout, stderr, exitCode } = await runCli(['start', agentDir, '--dry-run'], env);
    expect(stdout.trim().split('\n').at(-1)?.startsWith('pi --append-system-prompt')).toBe(true);
    expect(stderr).toContain('sandbox/nono.json not found');
    expect(exitCode).toBe(0);
  });

  it('should force the sandbox on with --sandbox when sandbox/nono.json is absent', async () => {
    await rm(join(agentDir, 'sandbox'), { recursive: true });
    const { stdout, exitCode } = await runCli(['start', agentDir, '--dry-run', '--sandbox'], env);
    const lines = stdout.trim().split('\n');
    expect(lines.some(line => line.startsWith('write: ') && line.endsWith('nono-profile.json'))).toBe(true);
    expect(lines.at(-1)).toContain('/mise-cache nono run --silent --profile ');
    expect(exitCode).toBe(0);
  });

  it('resolves a bare alias name via ~/.cradle/settings.json (HOME override), skipping bin checks on --dry-run', async () => {
    await mkdir(join(root, '.cradle'), { recursive: true });
    await writeFile(
      join(root, '.cradle', 'settings.json'),
      JSON.stringify({ agents: { hello: { path: agentDir } } }),
      'utf8'
    );
    const { stdout, exitCode } = await runCli(['start', 'hello', '--dry-run'], { ...env, HOME: root });
    const command = stdout.trim().split('\n').at(-1) ?? '';
    expect(command).toContain(`--append-system-prompt ${join(agentDir, 'APPEND_SYSTEM.md')}`);
    expect(exitCode).toBe(0);
  });

  it("omits --silent with --verbose to show nono's full capabilities banner", async () => {
    const { stdout, exitCode } = await runCli(['start', agentDir, '--dry-run', '--verbose'], env);
    const command = stdout.trim().split('\n').at(-1) ?? '';
    expect(command.startsWith('MISE_CACHE_DIR=')).toBe(true);
    expect(command).toContain('/mise-cache nono run --profile ');
    expect(command).not.toContain('--silent');
    expect(exitCode).toBe(0);
  });

  it('drops the nono wrapper with --no-sandbox', async () => {
    const { stdout, exitCode } = await runCli(['start', agentDir, '--dry-run', '--no-sandbox'], env);
    const lines = stdout.trim().split('\n');
    const command = lines.at(-1) ?? '';
    expect(command.startsWith('pi --append-system-prompt')).toBe(true);
    expect(command).not.toContain('nono');
    // No sandbox → no profile generated, so no profile write line.
    expect(lines.some(line => line.endsWith('nono-profile.json'))).toBe(false);
    expect(exitCode).toBe(0);
  });

  it('bakes --offline into the network posture and forwards args after `--` to pi', async () => {
    const { stdout, exitCode } = await runCli(['start', agentDir, '--dry-run', '--offline', '--', '--resume'], env);
    const command = stdout.trim().split('\n').at(-1) ?? '';
    // Network policy lives in the generated profile now, never as a nono flag.
    expect(command).not.toContain('--block-net');
    expect(command.endsWith('--resume')).toBe(true);
    // Network policy is disclosed by nono's startup banner, not echoed by cradle.
    expect(stdout).not.toContain('sandbox network:');
    expect(exitCode).toBe(0);
  });

  it('forwards numeric-looking passthrough tokens after `--` to pi verbatim, not yargs-coerced', async () => {
    const { stdout, exitCode } = await runCli(
      ['start', agentDir, '--dry-run', '--', '--temperature', '1.10', '08', '2.0', '1e3'],
      env
    );
    const command = stdout.trim().split('\n').at(-1) ?? '';
    // Un-fixed yargs numeric coercion would turn these into 1.1, 8, 2, 1000.
    expect(command.endsWith('--temperature 1.10 08 2.0 1e3')).toBe(true);
    expect(exitCode).toBe(0);
  });

  it('bakes --allow-host into the network allowlist via the generated profile', async () => {
    const { stdout, exitCode } = await runCli(
      ['start', agentDir, '--dry-run', '--allow-host', 'api.z.ai', '--allow-host', 'localhost'],
      env
    );
    // Network policy is disclosed by nono's startup banner, not echoed by cradle.
    expect(stdout).not.toContain('sandbox network:');
    // The profile is written and contains the generated command.
    expect(stdout).toContain('write: ');
    expect(stdout).toContain('nono-profile.json');
    expect(exitCode).toBe(0);
  });

  it('rejects a directory with neither SYSTEM.md nor APPEND_SYSTEM.md', async () => {
    const { stderr, exitCode } = await runCli(['start', root, '--dry-run'], env);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('not an agent folder');
  });

  it('composes pi --system-prompt for a SYSTEM.md-only folder (replaces pi’s prompt)', async () => {
    await rm(join(agentDir, 'APPEND_SYSTEM.md'));
    await writeFile(join(agentDir, 'SYSTEM.md'), '# Role\n', 'utf8');
    const { stdout, exitCode } = await runCli(['start', agentDir, '--dry-run', '--no-sandbox'], env);
    const command = stdout.trim().split('\n').at(-1) ?? '';
    expect(command.startsWith(`pi --system-prompt ${join(agentDir, 'SYSTEM.md')}`)).toBe(true);
    expect(command).not.toContain('--append-system-prompt');
    expect(exitCode).toBe(0);
  });

  it('surfaces folder warnings on stderr without failing the run', async () => {
    await writeFile(join(agentDir, 'notes.txt'), '', 'utf8');
    const { stderr, exitCode } = await runCli(['start', agentDir, '--dry-run'], env);
    expect(stderr).toContain('warning:');
    expect(stderr).toContain('notes.txt');
    expect(exitCode).toBe(0);
  });

  it('materializes the extensions, spawns pi with the composed argv, and propagates its exit code', async () => {
    const fakeBin = join(root, 'bin');
    await mkdir(fakeBin, { recursive: true });
    const fakePi = join(fakeBin, 'pi');
    await writeFile(fakePi, '#!/bin/sh\necho "PI_ARGS:$@"\nexit 7\n', 'utf8');
    await chmod(fakePi, 0o755);

    const { stdout, exitCode } = await runCli(['start', agentDir, '--no-sandbox'], {
      ...env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`
    });
    expect(exitCode).toBe(7);
    expect(stdout).toContain('PI_ARGS:');
    expect(stdout).toContain(`--append-system-prompt ${join(agentDir, 'APPEND_SYSTEM.md')}`);
    const stateAgents = join(root, 'state', 'agents');
    expect(await exists(stateAgents)).toBe(true);
  });

  it('reports a materialize failure as a one-line error, not a usage dump or stack trace', async () => {
    const fakeBin = join(root, 'bin');
    await mkdir(fakeBin, { recursive: true });
    const fakePi = join(fakeBin, 'pi');
    await writeFile(fakePi, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(fakePi, 0o755);
    const blocker = join(root, 'state-blocker');
    await writeFile(blocker, '', 'utf8');

    const { stderr, exitCode } = await runCli(['start', agentDir, '--no-sandbox'], {
      ...env,
      CRADLE_STATE_DIR: blocker,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('failed to write agent extensions');
    expect(stderr).not.toContain('Usage:');
    expect(stderr).not.toMatch(/\n\s+at /);
  });

  it('honors a folder-level "sandbox": false opt-out and warns loudly on stderr', async () => {
    await mkdir(join(agentDir, 'sandbox'), { recursive: true });
    await writeFile(join(agentDir, 'sandbox', 'nono.json'), JSON.stringify({ sandbox: false }));
    const { stdout, stderr, exitCode } = await runCli(['start', agentDir, '--dry-run'], env);
    const command = stdout.trim().split('\n').at(-1) ?? '';
    expect(command.startsWith('pi --append-system-prompt')).toBe(true);
    expect(command).not.toContain('nono');
    expect(stderr).toContain('sandbox disabled by sandbox/nono.json');
    expect(exitCode).toBe(0);
  });

  it('lets an explicit --sandbox flag override the folder opt-out', async () => {
    await mkdir(join(agentDir, 'sandbox'), { recursive: true });
    await writeFile(join(agentDir, 'sandbox', 'nono.json'), JSON.stringify({ sandbox: false }));
    const { stdout, exitCode } = await runCli(['start', agentDir, '--dry-run', '--sandbox'], env);
    const command = stdout.trim().split('\n').at(-1) ?? '';
    expect(command.startsWith('MISE_CACHE_DIR=')).toBe(true);
    expect(command).toContain('/mise-cache nono run --silent --profile ');
    expect(exitCode).toBe(0);
  });

  it('does not echo agent sandbox grants on stdout (disclosed by nono banner instead)', async () => {
    await mkdir(join(agentDir, 'sandbox'), { recursive: true });
    await writeFile(join(agentDir, 'sandbox', 'nono.json'), JSON.stringify({ filesystem: { write: ['~/out'] } }));
    const { stdout, exitCode } = await runCli(['start', agentDir, '--dry-run'], env);
    expect(stdout).not.toContain('sandbox grant:');
    // The profile is written and contains the grant.
    expect(stdout).toContain('write: ');
    expect(stdout).toContain('nono-profile.json');
    expect(exitCode).toBe(0);
  });

  it('prints the packages install plan on --dry-run when settings.json declares packages', async () => {
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-example-tool'] }), 'utf8');
    const { stdout, exitCode } = await runCli(['start', agentDir, '--dry-run'], env);
    const lines = stdout.trim().split('\n');
    expect(lines.some(line => line.startsWith('write: ') && line.endsWith(join('npm', 'package.json')))).toBe(true);
    expect(
      lines.some(line => line.startsWith('install: npm install ') && line.includes('pi-example-tool@latest'))
    ).toBe(true);
    // Dry-run never installs — the printed command still omits the package -e entries.
    const command = lines.at(-1) ?? '';
    expect(command).not.toContain('pi-example-tool');
    expect(exitCode).toBe(0);
  });

  it('does not echo agent seatbelt rules on stdout (disclosed by nono banner instead)', async () => {
    await mkdir(join(agentDir, 'sandbox'), { recursive: true });
    await writeFile(
      join(agentDir, 'sandbox', 'nono.json'),
      JSON.stringify({ unsafe_macos_seatbelt_rules: ['(allow mach-register)', '(allow iokit-open)'] })
    );
    const { stdout, exitCode } = await runCli(['start', agentDir, '--dry-run'], env);
    expect(stdout).not.toContain('sandbox rule:');
    // The profile is written and contains the rules.
    expect(stdout).toContain('write: ');
    expect(stdout).toContain('nono-profile.json');
    expect(exitCode).toBe(0);
  });
});

describe('doctor command', () => {
  it('reports pi (required), nono and mise (recommended); exits non-zero only when pi is absent', async () => {
    const { stdout, exitCode } = await runCli(['doctor']);
    expect(stdout).toContain('pi');
    expect(stdout).toContain('nono');
    expect(stdout).toContain('mise');
    expect([0, 1]).toContain(exitCode);
  });
});

describe('default command', () => {
  it('shows help when no command is given', async () => {
    const { stdout, exitCode } = await runCli([]);
    expect(stdout).toContain('start [dir]');
    expect(stdout).toContain('doctor');
    expect(stdout).not.toContain('setup');
    expect(stdout).toContain('<cmd>');
    expect(stdout).not.toContain('--harness');
    expect(exitCode).toBe(0);
  });
});

describe('--help flag', () => {
  it('prints help and exits 0', async () => {
    const { stdout, exitCode } = await runCli(['--help']);
    expect(stdout).toContain('start [dir]');
    expect(stdout).toContain('--help');
    expect(exitCode).toBe(0);
  });
});

describe('unknown command', () => {
  it('exits non-zero and surfaces the offending argument on stderr', async () => {
    const { stderr, exitCode } = await runCli(['nonexistent']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('nonexistent');
  });
});

describe('version', () => {
  it('shows version with --version', async () => {
    const { stdout, exitCode } = await runCli(['--version']);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(exitCode).toBe(0);
  });
});
