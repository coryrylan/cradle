import { describe, it, expect } from 'bun:test';

import type { AgentFolder } from './folder.js';
import { composeArgv, composeEnv, composePiArgv, type LaunchSpec } from './launch.js';

function createFolder(overrides: Partial<AgentFolder> = {}): AgentFolder {
  return {
    dir: '/agents/helper',
    appendSystemFilePath: '/agents/helper/APPEND_SYSTEM.md',
    settings: {},
    providersJson: null,
    skillsDir: null,
    extensionFiles: [],
    sandbox: {
      posture: 'enabled',
      filesystem: { read: [], write: [], allow: [] },
      unsafeMacosSeatbeltRules: []
    },
    warnings: [],
    ...overrides
  };
}

function createSpec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    folder: createFolder(),
    stateDir: '/state/helper',
    extensionsDir: '/state/helper/extensions',
    sessionsDir: '/state/helper/sessions',
    miseCacheDir: '/state/helper/mise-cache',
    sandbox: false,
    passthrough: [],
    nonoBin: 'nono',
    piBin: 'pi',
    profilePath: '/state/helper/nono-profile.json',
    ...overrides
  };
}

describe('composePiArgv', () => {
  it('should compose the full argv in order for a fully populated spec', () => {
    const spec = createSpec({
      folder: createFolder({
        settings: { defaultProvider: 'ollama', defaultModel: 'qwen', defaultThinkingLevel: 'low' },
        skillsDir: '/agents/helper/skills',
        extensionFiles: ['/agents/helper/extensions/flip.ts', '/agents/helper/extensions/hooks/index.ts'],
        providersJson: '/agents/helper/models.json'
      }),
      sandbox: true,
      passthrough: ['-p', 'hi']
    });
    expect(composePiArgv(spec)).toEqual([
      'pi',
      '--append-system-prompt',
      '/agents/helper/APPEND_SYSTEM.md',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '-e',
      '/state/helper/extensions/providers.ts',
      '-e',
      '/agents/helper/extensions/flip.ts',
      '-e',
      '/agents/helper/extensions/hooks/index.ts',
      '--skill',
      '/agents/helper/skills',
      '--provider',
      'ollama',
      '--model',
      'qwen',
      '--thinking',
      'low',
      '--session-dir',
      '/state/helper/sessions',
      '-p',
      'hi'
    ]);
  });

  it('should pass agent extensions as -e after the generated providers extension, sandboxed or not', () => {
    const extensionFiles = ['/agents/helper/extensions/flip.ts'];
    const sandboxed = composePiArgv(
      createSpec({
        folder: createFolder({ extensionFiles, providersJson: '/agents/helper/models.json' }),
        sandbox: true,
        extensionsDir: '/ext'
      })
    );
    expect(sandboxed.indexOf('/agents/helper/extensions/flip.ts')).toBeGreaterThan(
      sandboxed.indexOf('/ext/providers.ts')
    );
    const bare = composePiArgv(createSpec({ folder: createFolder({ extensionFiles }), sandbox: false }));
    expect(bare[bare.indexOf('-e') + 1]).toBe('/agents/helper/extensions/flip.ts');
  });

  it('should compose the exact minimal argv when every optional part is absent (unsandboxed)', () => {
    expect(composePiArgv(createSpec())).toEqual([
      'pi',
      '--append-system-prompt',
      '/agents/helper/APPEND_SYSTEM.md',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--session-dir',
      '/state/helper/sessions'
    ]);
  });

  it('should place the generated providers extension as the first -e when present', () => {
    const argv = composePiArgv(
      createSpec({
        folder: createFolder({ providersJson: '/agents/helper/models.json' }),
        sandbox: true,
        extensionsDir: '/ext'
      })
    );
    expect(argv[argv.indexOf('-e') + 1]).toBe('/ext/providers.ts');
  });

  it('should add no -e flags when no providers, packages, or agent extensions are present', () => {
    const argv = composePiArgv(createSpec({ sandbox: false }));
    expect(argv).not.toContain('-e');
  });

  it('should keep passthrough args last so they win under last-wins parsing', () => {
    const argv = composePiArgv(createSpec({ passthrough: ['-p', 'hi', '--session-dir', '/custom'] }));
    expect(argv.slice(-4)).toEqual(['-p', 'hi', '--session-dir', '/custom']);
  });

  it('should place package entries after the generated providers and before the folder extensions', () => {
    const folder = createFolder({
      extensionFiles: ['/agents/helper/extensions/flip.ts'],
      providersJson: '/agents/helper/models.json'
    });
    const argv = composePiArgv(
      createSpec({
        folder,
        sandbox: true,
        extensionsDir: '/ext',
        packageEntries: ['/state/helper/npm/node_modules/pi-example-tool/index.ts']
      })
    );
    const indexOf = (value: string) => argv.indexOf(value);
    expect(indexOf('/ext/providers.ts')).toBeLessThan(
      indexOf('/state/helper/npm/node_modules/pi-example-tool/index.ts')
    );
    expect(indexOf('/state/helper/npm/node_modules/pi-example-tool/index.ts')).toBeLessThan(
      indexOf('/agents/helper/extensions/flip.ts')
    );
  });

  it('should leave argv unchanged when packageEntries is absent', () => {
    const withEntries = createSpec({ packageEntries: ['/pkg/tool/index.ts'] });
    const { packageEntries, ...specWithoutEntries } = withEntries;
    void packageEntries;
    expect(composePiArgv(specWithoutEntries)).toEqual(composePiArgv(createSpec()));
  });

  it('should add no -e flags for an empty packageEntries array', () => {
    expect(composePiArgv(createSpec({ packageEntries: [] }))).toEqual(composePiArgv(createSpec()));
  });

  it('should spawn the resolved pi path (mise-shim fallback included), not a bare name', () => {
    const argv = composePiArgv(createSpec({ piBin: '/home/u/.local/share/mise/shims/pi' }));
    expect(argv[0]).toBe('/home/u/.local/share/mise/shims/pi');
  });

  it('should derive the providers -e path and --session-dir from the spec, never re-derive from stateDir', () => {
    // stateDir stays the default ('/state/helper'), but extensionsDir/sessionsDir are
    // overridden — proves composePiArgv trusts the spec's own fields instead of
    // recomputing statePaths(spec.stateDir), which would disagree here.
    const argv = composePiArgv(
      createSpec({
        folder: createFolder({ providersJson: '/agents/helper/models.json' }),
        extensionsDir: '/custom/extensions',
        sessionsDir: '/custom/sessions'
      })
    );
    expect(argv).toContain('/custom/extensions/providers.ts');
    expect(argv[argv.indexOf('--session-dir') + 1]).toBe('/custom/sessions');
  });
});

describe('composeArgv', () => {
  it('should return the bare pi argv when sandboxing is disabled', () => {
    const spec = createSpec({ sandbox: false, passthrough: ['-p', 'hi'] });
    const argv = composeArgv(spec);
    expect(argv).toEqual(composePiArgv(spec));
    expect(argv[0]).toBe('pi');
  });

  it('should wrap pi in nono run pointing at the generated per-agent profile when sandboxed, with --silent by default', () => {
    const spec = createSpec({ sandbox: true });
    // Grants no longer ride as flags — they live inside the profile file (see nono/profiles.ts).
    // --silent suppresses nono's startup banner by default.
    expect(composeArgv(spec)).toEqual([
      'nono',
      'run',
      '--silent',
      '--profile',
      '/state/helper/nono-profile.json',
      '--',
      ...composePiArgv(spec)
    ]);
  });

  it('should omit --silent when verbose is true', () => {
    const spec = createSpec({ sandbox: true, verbose: true });
    const argv = composeArgv(spec);
    expect(argv).not.toContain('--silent');
    expect(argv.slice(0, 4)).toEqual(['nono', 'run', '--profile', '/state/helper/nono-profile.json']);
  });

  it('should not carry any per-flag network posture — network lives in the profile now', () => {
    const argv = composeArgv(createSpec({ sandbox: true }));
    expect(argv).not.toContain('--block-net');
    // The wrapper is exactly `nono run --silent --profile <file> --` plus the pi argv.
    expect(argv.slice(0, 5)).toEqual(['nono', 'run', '--silent', '--profile', '/state/helper/nono-profile.json']);
    expect(argv[5]).toBe('--');
  });

  it('should spawn the resolved nono and pi paths, not bare names, once both are resolved', () => {
    const argv = composeArgv(
      createSpec({
        sandbox: true,
        nonoBin: '/home/u/.local/share/mise/shims/nono',
        piBin: '/home/u/.local/share/mise/shims/pi'
      })
    );
    expect(argv[0]).toBe('/home/u/.local/share/mise/shims/nono');
    expect(argv[argv.indexOf('--') + 1]).toBe('/home/u/.local/share/mise/shims/pi');
  });

  it('should use the resolved pi path for an unsandboxed spawn, not the bare name', () => {
    const argv = composeArgv(createSpec({ sandbox: false, piBin: '/home/u/.local/share/mise/shims/pi' }));
    expect(argv[0]).toBe('/home/u/.local/share/mise/shims/pi');
  });
});

describe('composeEnv', () => {
  it('should point MISE_CACHE_DIR at the spec miseCacheDir when sandboxed', () => {
    const spec = createSpec({ sandbox: true, miseCacheDir: '/state/helper/mise-cache' });
    expect(composeEnv(spec)).toEqual({ MISE_CACHE_DIR: '/state/helper/mise-cache' });
  });

  it('should return no env entries when unsandboxed, keeping the shared host mise cache', () => {
    expect(composeEnv(createSpec({ sandbox: false }))).toEqual({});
  });
});
