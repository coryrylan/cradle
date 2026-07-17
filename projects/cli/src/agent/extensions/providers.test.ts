import { describe, it, expect } from 'bun:test';
import { emitProvidersExtension } from './providers.js';

const providers = {
  ollama: { baseUrl: 'http://localhost:11434/v1', apiKey: 'none' },
  spark: { baseUrl: 'http://x/v1', models: [{ id: 'm', reasoning: true }] }
};
const providersJson = JSON.stringify(providers, null, 2);

const transpile = (src: string) => new Bun.Transpiler({ loader: 'ts' }).transformSync(src);

describe('emitProvidersExtension', () => {
  it('should emit valid typescript', () => {
    expect(() => transpile(emitProvidersExtension(providersJson))).not.toThrow();
  });

  it('should bake the providers object so it round-trips through JSON', () => {
    const src = emitProvidersExtension(providersJson);
    const start = src.indexOf('const providers = ') + 'const providers = '.length;
    const end = src.indexOf(' as const;');
    expect(JSON.parse(src.slice(start, end))).toEqual(providers);
  });

  it('should register every provider through the extension api', () => {
    expect(emitProvidersExtension(providersJson)).toContain('registerProvider');
  });
});
