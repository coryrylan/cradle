import { describe, expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { emitMcpExtension, MCP_EXTENSION_FILE } from './mcp.js';

function registerServers(serversJson: string, failure?: unknown) {
  const registered: { name: string; config: unknown }[] = [];
  const warnings: string[] = [];
  const source = emitMcpExtension(serversJson).replace('export default ', '');
  const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
  runInNewContext(`${executable}\nregisterMcpServers(pi);`, {
    pi: {
      registerMcpServer: (name: string, config: unknown) => {
        if (name === 'invalid') throw failure;
        registered.push({ name, config });
      }
    },
    console: { warn: (message: string) => warnings.push(message) }
  });
  return { registered, warnings };
}

describe('emitMcpExtension', () => {
  it('should emit valid TypeScript at the generated extension filename', () => {
    expect(MCP_EXTENSION_FILE).toBe('mcp.ts');
    expect(registerServers('{}')).toEqual({ registered: [], warnings: [] });
  });

  it('should preserve server values and environment placeholders for Pi to interpret', () => {
    const servers = {
      local: { command: 'node', args: ['server.mjs'], env: { TOKEN: '${MCP_TOKEN}' }, cwd: './tools' },
      remote: { url: 'https://example.com/mcp', exposure: 'deferred', enabled: false },
      malformed: null
    };
    expect(registerServers(JSON.stringify(servers))).toEqual({
      registered: Object.entries(servers).map(([name, config]) => ({ name, config })),
      warnings: []
    });
  });

  it('should preserve special JSON keys and strings without evaluating them as source', () => {
    const json = '{"__proto__":{"url":"https://example.com/mcp"},"quoted":{"args":["` ${process.exit(1)}"]}}';
    expect(registerServers(json).registered.map(server => server.name)).toEqual(['__proto__', 'quoted']);
    expect(registerServers(json).registered[1]?.config).toEqual({ args: ['` ${process.exit(1)}'] });
  });

  it('should report Pi validation failures and continue registering other servers', () => {
    for (const failure of [new Error('Invalid server'), 'Invalid server']) {
      const result = registerServers('{"invalid":{},"valid":{"command":"node"}}', failure);
      expect(result.registered).toEqual([{ name: 'valid', config: { command: 'node' } }]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('MCP server "invalid" was not registered:');
      expect(result.warnings[0]).toContain('Invalid server');
    }
  });
});
