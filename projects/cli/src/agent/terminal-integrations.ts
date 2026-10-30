import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { SandboxBackend } from './folder.js';

export interface TerminalIntegrations {
  readonly extensionFiles: readonly string[];
  readonly socketPaths: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

interface TerminalIntegrationSpec {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly backend: SandboxBackend | null;
  readonly enabled: boolean;
}

/** Discover installed host terminal hooks with live Unix sockets, independently of the portable agent folder. */
export async function getTerminalIntegrations({
  home,
  env,
  platform,
  backend,
  enabled
}: TerminalIntegrationSpec): Promise<TerminalIntegrations> {
  const inHerdr = enabled && env.HERDR_ENV === '1';
  const result: TerminalIntegrations = {
    extensionFiles: [],
    socketPaths: [],
    env: inHerdr ? { HERDR_AGENT: 'pi' } : {}
  };
  if (!enabled || backend === 'sbx' || platform === 'win32') return result;
  const extensionsDir = join(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), 'extensions');
  const candidates = [
    { extension: 'herdr-agent-state.ts', socket: inHerdr ? env.HERDR_SOCKET_PATH : undefined },
    { extension: 'moshi-hooks.ts', socket: getMoshiSocketPath(home, env, platform) }
  ];
  const active = await Promise.all(
    candidates.map(async ({ extension, socket }) => {
      if (socket === undefined || !isAbsolute(socket)) return null;
      const file = join(extensionsDir, extension);
      // Host daemons and their installers can replace these files during discovery.
      try {
        const [extensionStatus, socketStatus] = await Promise.all([stat(file), stat(socket)]);
        if (!extensionStatus.isFile() || !socketStatus.isSocket()) return null;
        return { file: await realpath(file), socket };
      } catch {
        return null;
      }
    })
  );
  return {
    ...result,
    extensionFiles: [...new Set(active.flatMap(integration => (integration === null ? [] : [integration.file])))],
    socketPaths: [...new Set(active.flatMap(integration => (integration === null ? [] : [integration.socket])))]
  };
}

function getMoshiSocketPath(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform
): string {
  if (env.MOSHI_SOCKET_PATH) return env.MOSHI_SOCKET_PATH;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Moshi', 'moshi-hook.sock');
  return env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'moshi-hook.sock') : '/tmp/moshi-hook.sock';
}
