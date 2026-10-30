import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { materializeRun, planRun } from '../commands/run.js';
import { composeEnv, composePiArgv } from './launch.js';
import { getTerminalIntegrations } from './terminal-integrations.js';

let root: string;
let extensionsDir: string;
let servers: Server[];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ct-')));
  extensionsDir = join(root, '.pi', 'agent', 'extensions');
  servers = [];
  await mkdir(extensionsDir, { recursive: true });
});

afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await rm(root, { recursive: true, force: true });
});

async function createSocket(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  servers.push(server);
  return path;
}

async function createHooks(): Promise<void> {
  await Promise.all(
    ['herdr-agent-state.ts', 'moshi-hooks.ts', 'personal-tool.ts'].map(name =>
      writeFile(join(extensionsDir, name), 'export default () => {};')
    )
  );
}

function getIntegrations(env: Record<string, string> = {}, platform: NodeJS.Platform = 'linux') {
  return getTerminalIntegrations({ home: root, env, platform, backend: 'nono', enabled: true });
}

describe('getTerminalIntegrations', () => {
  it('should load only installed terminal hooks with active sockets and identify the host wrapper as pi', async () => {
    await createHooks();
    const herdrSocket = await createSocket(join(root, 'h.sock'));
    const moshiSocket = await createSocket(join(root, 'm.sock'));
    expect(
      await getIntegrations({ HERDR_ENV: '1', HERDR_SOCKET_PATH: herdrSocket, MOSHI_SOCKET_PATH: moshiSocket })
    ).toEqual({
      extensionFiles: [join(extensionsDir, 'herdr-agent-state.ts'), join(extensionsDir, 'moshi-hooks.ts')],
      socketPaths: [herdrSocket, moshiSocket],
      env: { HERDR_AGENT: 'pi' }
    });
  });

  it('should ignore missing daemons, missing hooks, regular files, and relative socket paths', async () => {
    const socket = await createSocket(join(root, 'm.sock'));
    expect((await getIntegrations({ MOSHI_SOCKET_PATH: socket })).extensionFiles).toEqual([]);
    await createHooks();
    await writeFile(join(root, 'regular'), '');
    for (const path of [join(root, 'absent.sock'), join(root, 'regular'), 'relative.sock']) {
      expect((await getIntegrations({ MOSHI_SOCKET_PATH: path })).socketPaths).toEqual([]);
    }
  });

  it('should require the Herdr pane environment even when the socket is present', async () => {
    await createHooks();
    const socket = await createSocket(join(root, 'h.sock'));
    const result = await getIntegrations({ HERDR_SOCKET_PATH: socket, MOSHI_SOCKET_PATH: join(root, 'missing') });
    expect(result).toEqual({ extensionFiles: [], socketPaths: [], env: {} });
  });

  it('should honor PI_CODING_AGENT_DIR, resolve symlinked hooks, and preserve socket paths', async () => {
    const custom = join(root, 'custom');
    await mkdir(join(custom, 'extensions'), { recursive: true });
    await createHooks();
    const socket = await createSocket(join(root, 'm.sock'));
    await symlink(join(extensionsDir, 'moshi-hooks.ts'), join(custom, 'extensions', 'moshi-hooks.ts'));
    await symlink(socket, join(root, 'linked.sock'));
    const result = await getIntegrations({ PI_CODING_AGENT_DIR: custom, MOSHI_SOCKET_PATH: join(root, 'linked.sock') });
    expect(result.extensionFiles).toEqual([join(extensionsDir, 'moshi-hooks.ts')]);
    expect(result.socketPaths).toEqual([join(root, 'linked.sock')]);
  });

  it('should follow Moshi platform defaults on macOS and Linux', async () => {
    await createHooks();
    const macSocket = join(root, 'Library', 'Application Support', 'Moshi', 'moshi-hook.sock');
    // Keep the Unix socket under the platform path-length limit while testing the default directory layout.
    await mkdir(dirname(macSocket), { recursive: true });
    const socket = await createSocket(join(root, 'm.sock'));
    await symlink(socket, macSocket);
    expect((await getIntegrations({}, 'darwin')).socketPaths).toEqual([macSocket]);
    const runtimeDir = join(root, 'runtime');
    await mkdir(runtimeDir);
    await symlink(socket, join(runtimeDir, 'moshi-hook.sock'));
    expect((await getIntegrations({ XDG_RUNTIME_DIR: runtimeDir })).socketPaths).toEqual([
      join(runtimeDir, 'moshi-hook.sock')
    ]);
  });

  it('should omit host hooks and socket grants for sbx and Windows, retaining the Herdr host hint', async () => {
    await createHooks();
    const socket = await createSocket(join(root, 'm.sock'));
    const env = { HERDR_ENV: '1', HERDR_SOCKET_PATH: socket, MOSHI_SOCKET_PATH: socket };
    for (const spec of [
      { backend: 'sbx' as const, platform: 'linux' as const },
      { backend: null, platform: 'win32' as const }
    ]) {
      expect(await getTerminalIntegrations({ home: root, env, enabled: true, ...spec })).toEqual({
        extensionFiles: [],
        socketPaths: [],
        env: { HERDR_AGENT: 'pi' }
      });
    }
  });

  it('should leave scheduled runs unchanged even when terminal hooks and sockets are available', async () => {
    await createHooks();
    const socket = await createSocket(join(root, 'm.sock'));
    expect(
      await getTerminalIntegrations({
        home: root,
        platform: 'linux',
        backend: 'nono',
        enabled: false,
        env: { HERDR_ENV: '1', HERDR_SOCKET_PATH: socket, MOSHI_SOCKET_PATH: socket }
      })
    ).toEqual({ extensionFiles: [], socketPaths: [], env: {} });
  });
});

describe('planRun terminal integrations', () => {
  it('should materialize declared connect-only sockets without installed terminal integrations', async () => {
    const agentDir = join(root, 'agent');
    await mkdir(join(agentDir, 'sandbox'), { recursive: true });
    await writeFile(join(agentDir, 'APPEND_SYSTEM.md'), '# Agent');
    await writeFile(
      join(agentDir, 'sandbox', 'nono.json'),
      JSON.stringify({
        filesystem: { unix_socket: ['~/.config/herdr/herdr.sock', '$HOME/moshi.sock'] }
      })
    );
    const plan = await planRun({ dir: agentDir, dryRun: true }, { home: root, cwd: agentDir, env: {} });
    await materializeRun(plan);
    const profile = JSON.parse(await readFile(plan.profile?.path ?? '', 'utf8'));
    expect(profile.filesystem.unix_socket).toEqual([join(root, '.config/herdr/herdr.sock'), join(root, 'moshi.sock')]);
    expect(profile.filesystem.unix_socket_bind).toBeUndefined();
    expect(profile.filesystem.unix_socket_dir_bind).toBeUndefined();
    expect(plan.launch.terminalIntegrations?.extensionFiles).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it('should compose explicit hooks and exact connect-only grants into the materialized nono plan', async () => {
    await createHooks();
    const herdrSocket = await createSocket(join(root, 'h.sock'));
    const moshiSocket = await createSocket(join(root, 'm.sock'));
    const agentDir = join(root, 'agent');
    await mkdir(join(agentDir, 'sandbox'), { recursive: true });
    await writeFile(join(agentDir, 'APPEND_SYSTEM.md'), '# Agent');
    await writeFile(join(agentDir, 'sandbox', 'nono.json'), '{}');
    const plan = await planRun(
      { dir: agentDir, dryRun: true },
      {
        home: root,
        cwd: agentDir,
        platform: 'linux',
        env: { HERDR_ENV: '1', HERDR_SOCKET_PATH: herdrSocket, MOSHI_SOCKET_PATH: moshiSocket }
      }
    );
    const { argv } = await materializeRun(plan);
    expect(argv).toContain('--no-extensions');
    expect(argv).toContain(join(extensionsDir, 'herdr-agent-state.ts'));
    expect(argv).toContain(join(extensionsDir, 'moshi-hooks.ts'));
    expect(argv).not.toContain(join(extensionsDir, 'personal-tool.ts'));
    expect(composeEnv(plan.launch)).toEqual({ MISE_CACHE_DIR: plan.launch.miseCacheDir, HERDR_AGENT: 'pi' });
    const filesystem = JSON.parse(plan.profile?.content ?? '{}').filesystem;
    expect(filesystem.unix_socket).toEqual([herdrSocket, moshiSocket]);
    expect(filesystem.unix_socket_bind).toBeUndefined();
    expect(filesystem.unix_socket_dir_bind).toBeUndefined();
    expect(filesystem.allow).not.toContain(root);
    expect(filesystem.read).toContain(join(extensionsDir, 'herdr-agent-state.ts'));
    expect(filesystem.read).toContain(join(extensionsDir, 'moshi-hooks.ts'));
    expect(await readFile(plan.profile?.path ?? '', 'utf8')).toBe(plan.profile?.content ?? '');
  });

  it('should deduplicate explicit extensions and preserve terminal reporting without nono', async () => {
    await createHooks();
    const socket = await createSocket(join(root, 'm.sock'));
    const agentDir = join(root, 'agent');
    await mkdir(agentDir);
    await writeFile(join(agentDir, 'APPEND_SYSTEM.md'), '# Agent');
    const plan = await planRun(
      { dir: agentDir, dryRun: true, noSandbox: true },
      {
        home: root,
        cwd: agentDir,
        platform: 'linux',
        env: { MOSHI_SOCKET_PATH: socket }
      }
    );
    const hook = join(extensionsDir, 'moshi-hooks.ts');
    const argv = composePiArgv({
      ...plan.launch,
      packageEntries: [hook],
      folder: { ...plan.launch.folder, extensionFiles: [hook] }
    });
    expect(argv.filter(argument => argument === hook)).toHaveLength(1);
    expect(composeEnv(plan.launch)).toEqual({});
    expect(plan.profile).toBeNull();
  });
});
