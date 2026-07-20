import { describe, it, expect } from 'bun:test';
import { runInNewContext } from 'node:vm';
import {
  AGENT_BROWSER_NONO_FALLBACK_EXTENSION_FILE,
  emitAgentBrowserNonoFallbackExtension
} from './agent-browser-nono-fallback.js';

interface AgentBrowserEnvironment {
  readonly args?: string;
  readonly proxy?: string;
}

const transpile = (source: string): string => new Bun.Transpiler({ loader: 'ts' }).transformSync(source);

function runExtension(env: Record<string, string>, platform = 'darwin'): AgentBrowserEnvironment {
  const context = { process: { env: { ...env }, platform } };
  const executableSource = emitAgentBrowserNonoFallbackExtension().replace('export default ', '');
  runInNewContext(`${transpile(executableSource)}\nconfigureAgentBrowserNonoEnvironment({});`, context);
  return {
    ...(context.process.env.AGENT_BROWSER_ARGS !== undefined ? { args: context.process.env.AGENT_BROWSER_ARGS } : {}),
    ...(context.process.env.AGENT_BROWSER_PROXY !== undefined ? { proxy: context.process.env.AGENT_BROWSER_PROXY } : {})
  };
}

describe('emitAgentBrowserNonoFallbackExtension', () => {
  it('should emit valid typescript with pi’s required default factory at the stable generated filename', () => {
    const source = emitAgentBrowserNonoFallbackExtension();
    expect(AGENT_BROWSER_NONO_FALLBACK_EXTENSION_FILE).toBe('agent-browser-nono-fallback.ts');
    expect(() => transpile(source)).not.toThrow();
    expect(source).toContain('export default function configureAgentBrowserNonoEnvironment');
  });

  it('should append Chrome’s no-sandbox argument and forward nono’s HTTPS proxy', () => {
    expect(
      runExtension({ AGENT_BROWSER_ARGS: '--disable-gpu', HTTPS_PROXY: 'http://nono:token@127.0.0.1:1234' })
    ).toEqual({
      args: '--disable-gpu,--no-sandbox',
      proxy: 'http://nono:token@127.0.0.1:1234'
    });
  });

  it('should deduplicate no-sandbox, preserve an explicit proxy, and fall back to HTTP_PROXY', () => {
    expect(
      runExtension({
        AGENT_BROWSER_ARGS: '--no-sandbox,--disable-gpu,--no-sandbox',
        AGENT_BROWSER_PROXY: 'http://explicit:8080',
        HTTPS_PROXY: 'http://nono:1234',
        HTTP_PROXY: 'http://nono:5678'
      })
    ).toEqual({ args: '--disable-gpu,--no-sandbox', proxy: 'http://explicit:8080' });
    expect(runExtension({ HTTP_PROXY: 'http://nono:5678' })).toEqual({
      args: '--no-sandbox',
      proxy: 'http://nono:5678'
    });
  });

  it('should leave the proxy unset when nono did not inject one', () => {
    expect(runExtension({})).toEqual({ args: '--no-sandbox' });
  });

  it('should keep Chrome’s nested sandbox outside macOS while still forwarding the proxy', () => {
    expect(runExtension({ HTTPS_PROXY: 'http://nono:1234' }, 'linux')).toEqual({
      proxy: 'http://nono:1234'
    });
  });
});
