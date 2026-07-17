import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import { exists, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeArgv } from '../agent/launch.js';
import { stateDirFor } from '../agent/state.js';
import { createWhichStub } from '../util/which.js';
import { materializeStart, planStart } from './start.js';

let root: string;
let agentDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cradle-run-'));
  agentDir = join(root, 'my-agent');
  process.env.CRADLE_STATE_DIR = join(root, 'state');
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'APPEND_SYSTEM.md'), '# Role\n', 'utf8');
  await addFile('sandbox/nono.json', '{}');
});
afterEach(async () => {
  delete process.env.CRADLE_STATE_DIR;
  await rm(root, { recursive: true, force: true });
});

async function addFile(rel: string, content: string): Promise<void> {
  const path = join(agentDir, rel);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

const allBins = { nono: '/shims/nono', pi: '/shims/pi' };
const deps = { cwd: '/work', home: '/home/u', which: createWhichStub(allBins) };
const relFiles = (plan: { files: readonly { rel: string }[] }) => plan.files.map(file => file.rel);

describe('planStart', () => {
  it('should compose a sandboxed plan with the resolved nono, including --silent by default', async () => {
    const plan = await planStart({ dir: agentDir }, deps);
    const stateDir = stateDirFor(agentDir, '/home/u');
    const profilePath = join(stateDir, 'nono-profile.json');
    expect(composeArgv(plan.launch)[0]).toBe('/shims/nono');
    // Grants live in the profile now; the wrapper just points nono at it.
    // --silent suppresses nono's startup banner by default.
    expect(composeArgv(plan.launch)).not.toContain('--allow');
    expect(composeArgv(plan.launch).slice(0, 5)).toEqual(['/shims/nono', 'run', '--silent', '--profile', profilePath]);
    expect(plan.extensionsDir).toBe(join(stateDir, 'extensions'));
    expect(plan.sessionsDir).toBe(join(stateDir, 'sessions'));
    expect(relFiles(plan)).toEqual([]);
    expect(plan.profile?.path).toBe(profilePath);
    expect(JSON.parse(plan.profile?.content ?? '{}').extends).toBe('default');
    expect(plan.dryRun).toBe(false);
  });

  it('should run unsandboxed and warn when sandbox/nono.json is absent', async () => {
    await rm(join(agentDir, 'sandbox'), { recursive: true });
    const plan = await planStart({ dir: agentDir }, { ...deps, which: createWhichStub({ pi: '/shims/pi' }) });
    expect(composeArgv(plan.launch)[0]).toBe('pi');
    expect(plan.profile).toBeNull();
    expect(plan.warnings.join('\n')).toContain('sandbox/nono.json not found');
  });

  it('should omit --silent when verbose is true', async () => {
    const plan = await planStart({ dir: agentDir, verbose: true }, deps);
    const stateDir = stateDirFor(agentDir, '/home/u');
    const profilePath = join(stateDir, 'nono-profile.json');
    expect(composeArgv(plan.launch).slice(0, 4)).toEqual(['/shims/nono', 'run', '--profile', profilePath]);
    expect(composeArgv(plan.launch)).not.toContain('--silent');
  });

  it('should skip bin checks on dry-run and keep the bare nono name', async () => {
    const throwingWhich = () => {
      throw new Error('which must not be called on dry-run');
    };
    const plan = await planStart({ dir: agentDir, dryRun: true }, { ...deps, which: throwingWhich });
    expect(composeArgv(plan.launch)[0]).toBe('nono');
    expect(plan.dryRun).toBe(true);
  });

  it('should require pi even when unsandboxed', async () => {
    const which = createWhichStub({ nono: '/shims/nono' });
    await expect(planStart({ dir: agentDir, noSandbox: true }, { ...deps, which })).rejects.toThrow(
      'required executable "pi"'
    );
  });

  it('should not require nono when unsandboxed', async () => {
    const which = createWhichStub({ pi: '/shims/pi' });
    const plan = await planStart({ dir: agentDir, noSandbox: true }, { ...deps, which });
    expect(composeArgv(plan.launch)[0]).toBe('pi');
    expect(composeArgv(plan.launch)).not.toContain('nono');
    // No sandbox → no nono profile to generate.
    expect(plan.profile).toBeNull();
  });

  it('should emit the providers extension only when the agent defines models.json', async () => {
    await addFile('models.json', JSON.stringify({ providers: { ollama: { baseUrl: 'http://x/v1' } } }));
    const plan = await planStart({ dir: agentDir }, deps);
    expect(relFiles(plan)).toEqual(['providers.ts']);
    expect(composeArgv(plan.launch)).toContain(join(plan.extensionsDir, 'providers.ts'));
  });

  it('should pass agent extensions/ files straight through as -e paths, nothing generated', async () => {
    await addFile('extensions/flip.ts', 'export default function () {};\n');
    const plan = await planStart({ dir: agentDir }, deps);
    expect(relFiles(plan)).toEqual([]);
    expect(composeArgv(plan.launch)).toContain(join(agentDir, 'extensions', 'flip.ts'));
  });

  const profileNetwork = (plan: { profile?: { content: string } | null }) =>
    JSON.parse(plan.profile?.content ?? '{}').network;

  it('should bake the folder network block into the generated profile, canonical keys', async () => {
    await addFile('sandbox/nono.json', JSON.stringify({ network: { allow_domain: ['api.z.ai'], open_port: [11434] } }));
    const plan = await planStart({ dir: agentDir }, deps);
    expect(profileNetwork(plan)).toEqual({ allow_domain: ['api.z.ai'], open_port: [11434] });
    // Network no longer rides as a flag.
    expect(composeArgv(plan.launch)).not.toContain('--block-net');
  });

  it('should omit the network block entirely when no policy is set (nono default: open)', async () => {
    const plan = await planStart({ dir: agentDir }, deps);
    expect(profileNetwork(plan)).toBeUndefined();
  });

  it('should resolve network precedence as --offline > --allow-host > folder > open', async () => {
    await addFile('sandbox/nono.json', JSON.stringify({ network: { allow_domain: ['folder.example'] } }));
    // Folder wins with no flags.
    expect(profileNetwork(await planStart({ dir: agentDir }, deps))).toEqual({ allow_domain: ['folder.example'] });
    // --allow-host overrides the folder allowlist.
    const allowHost = await planStart({ dir: agentDir, allowHost: ['api.z.ai', 'localhost'] }, deps);
    expect(profileNetwork(allowHost)).toEqual({ allow_domain: ['api.z.ai', 'localhost'] });
    // --offline overrides everything.
    const offline = await planStart({ dir: agentDir, offline: true, allowHost: ['api.z.ai'] }, deps);
    expect(profileNetwork(offline)).toEqual({ block: true });
  });

  it('should bake the network posture into the profile, disclosed by nono not cradle', async () => {
    await addFile('sandbox/nono.json', JSON.stringify({ network: { allow_domain: ['api.z.ai', 'localhost'] } }));
    const sandboxed = await planStart({ dir: agentDir }, deps);
    expect(JSON.parse(sandboxed.profile?.content ?? '{}').network).toEqual({
      allow_domain: ['api.z.ai', 'localhost']
    });
    // Unsandboxed runs generate no profile.
    const bare = await planStart(
      { dir: agentDir, noSandbox: true },
      { ...deps, which: createWhichStub({ pi: '/shims/pi' }) }
    );
    expect(bare.profile).toBeNull();
  });

  it('should warn that a restrictive network policy is unenforced on an unsandboxed run', async () => {
    const which = createWhichStub({ pi: '/shims/pi' });
    const plan = await planStart({ dir: agentDir, offline: true, noSandbox: true }, { ...deps, which });
    expect(plan.warnings.join('\n')).toContain('network policy has no effect without the sandbox');
    // A merely-permissive posture (ports only) does NOT trigger the warning.
    await addFile('sandbox/nono.json', JSON.stringify({ network: { open_port: [8080] } }));
    const permissive = await planStart({ dir: agentDir, noSandbox: true }, { ...deps, which });
    expect(permissive.warnings.join('\n')).not.toContain('network policy has no effect');
  });

  it('should propagate folder warnings and forward passthrough last', async () => {
    await addFile('notes.txt', '');
    const plan = await planStart({ dir: agentDir, passthrough: ['-p', 'hi'] }, deps);
    expect(plan.warnings.join('\n')).toContain('notes.txt');
    expect(composeArgv(plan.launch).slice(-2)).toEqual(['-p', 'hi']);
  });

  it('should bake the agent filesystem grants into the profile, disclosed by nono not cradle', async () => {
    await addFile('sandbox/nono.json', JSON.stringify({ filesystem: { read: ['~/data'], allow: ['/scratch'] } }));
    const sandboxed = await planStart({ dir: agentDir }, deps);
    const profile = JSON.parse(sandboxed.profile?.content ?? '{}');
    expect(profile.filesystem.read).toContain('/home/u/data');
    expect(profile.filesystem.allow).toContain('/scratch');
  });

  it('should bake the agent seatbelt rules into the profile', async () => {
    const rules = ['(allow mach-register)', '(allow iokit-open)'];
    await addFile('sandbox/nono.json', JSON.stringify({ unsafe_macos_seatbelt_rules: rules }));
    const sandboxed = await planStart({ dir: agentDir }, deps);
    // Rules land after the base rules in the generated profile (last-match-wins).
    const profileRules = JSON.parse(sandboxed.profile?.content ?? '{}').unsafe_macos_seatbelt_rules;
    expect(profileRules.slice(-2)).toEqual(rules);
    // Unsandboxed runs generate no profile.
    const bare = await planStart({ dir: agentDir, noSandbox: true }, deps);
    expect(bare.profile).toBeNull();
  });

  it('should honor a folder sandbox opt-out with a loud warning and no nono requirement', async () => {
    await addFile('sandbox/nono.json', JSON.stringify({ sandbox: false }));
    // Only pi on PATH — nono must not be required when the folder opts out.
    const which = createWhichStub({ pi: '/shims/pi' });
    const plan = await planStart({ dir: agentDir }, { ...deps, which });
    expect(composeArgv(plan.launch)[0]).toBe('pi');
    expect(plan.profile).toBeNull();
    expect(plan.warnings.join('\n')).toContain('sandbox disabled by sandbox/nono.json');
  });

  it('should let an explicit --sandbox override the folder opt-out, without the opt-out warning', async () => {
    await addFile('sandbox/nono.json', JSON.stringify({ sandbox: false, filesystem: { allow: ['~/scratch'] } }));
    const plan = await planStart({ dir: agentDir, noSandbox: false }, deps);
    expect(composeArgv(plan.launch)[0]).toBe('/shims/nono');
    expect(plan.profile).not.toBeNull();
    // The folder's grants still apply when the sandbox is forced back on.
    expect(JSON.parse(plan.profile?.content ?? '{}').filesystem.allow).toContain('/home/u/scratch');
    expect(plan.warnings.join('\n')).not.toContain('sandbox disabled');
  });

  it('should not warn about the folder opt-out when --no-sandbox was the user’s own choice', async () => {
    await addFile('sandbox/nono.json', JSON.stringify({ sandbox: false }));
    const which = createWhichStub({ pi: '/shims/pi' });
    const plan = await planStart({ dir: agentDir, noSandbox: true }, { ...deps, which });
    expect(composeArgv(plan.launch)[0]).toBe('pi');
    expect(plan.warnings.join('\n')).not.toContain('sandbox disabled');
  });

  it('should force sandboxing on with --sandbox when sandbox/nono.json is absent', async () => {
    await rm(join(agentDir, 'sandbox'), { recursive: true });
    const plan = await planStart({ dir: agentDir, noSandbox: false }, deps);
    expect(composeArgv(plan.launch)[0]).toBe('/shims/nono');
    expect(plan.profile).not.toBeNull();
  });

  it('should force sandboxing on with --offline when sandbox/nono.json is absent', async () => {
    await rm(join(agentDir, 'sandbox'), { recursive: true });
    const plan = await planStart({ dir: agentDir, offline: true }, deps);
    expect(composeArgv(plan.launch)[0]).toBe('/shims/nono');
    expect(JSON.parse(plan.profile?.content ?? '{}').network).toMatchObject({ block: true });
    expect(plan.warnings.join('\n')).toContain('sandbox forced on to enforce the requested network policy');
  });

  it('should force sandboxing on with --allow-host when sandbox/nono.json is absent', async () => {
    await rm(join(agentDir, 'sandbox'), { recursive: true });
    const plan = await planStart({ dir: agentDir, allowHost: ['registry.npmjs.org'] }, deps);
    expect(composeArgv(plan.launch)[0]).toBe('/shims/nono');
    expect(JSON.parse(plan.profile?.content ?? '{}').network.allow_domain).toContain('registry.npmjs.org');
    expect(plan.warnings.join('\n')).toContain('sandbox forced on to enforce the requested network policy');
  });

  it('should force sandboxing on with --offline even when the folder opts out, citing the opt-out reason', async () => {
    await addFile('sandbox/nono.json', JSON.stringify({ sandbox: false }));
    const plan = await planStart({ dir: agentDir, offline: true }, deps);
    expect(composeArgv(plan.launch)[0]).toBe('/shims/nono');
    expect(JSON.parse(plan.profile?.content ?? '{}').network).toMatchObject({ block: true });
    expect(plan.warnings.join('\n')).toContain(
      'sandbox disabled by sandbox/nono.json — sandbox forced on to enforce the requested network policy'
    );
  });

  it('should stay unsandboxed and warn with the new message when --no-sandbox overrides --offline', async () => {
    const which = createWhichStub({ pi: '/shims/pi' });
    const plan = await planStart({ dir: agentDir, noSandbox: true, offline: true }, { ...deps, which });
    expect(composeArgv(plan.launch)[0]).toBe('pi');
    expect(plan.warnings.join('\n')).toContain('network policy has no effect without the sandbox');
  });

  it('should keep the sandbox/ has no nono.json loader warning even when --sandbox is explicit', async () => {
    await rm(join(agentDir, 'sandbox', 'nono.json'));
    const plan = await planStart({ dir: agentDir, noSandbox: false }, deps);
    expect(plan.warnings.join('\n')).toContain('sandbox/ has no nono.json');
  });

  it('should leave packages null when the folder declares none', async () => {
    const plan = await planStart({ dir: agentDir }, deps);
    expect(plan.packages).toBeNull();
  });

  it('should build a packages plan when settings.json declares packages', async () => {
    await addFile('settings.json', JSON.stringify({ packages: ['npm:pi-example-tool@0.13.0'] }));
    const plan = await planStart({ dir: agentDir }, deps);
    const stateDir = stateDirFor(agentDir, '/home/u');
    expect(plan.packages?.npmDir).toBe(join(stateDir, 'npm'));
    expect(plan.packages?.specs).toEqual([{ name: 'pi-example-tool', version: '0.13.0' }]);
    expect(plan.packages?.installCommand).toEqual(['npm', 'install']);
    expect(JSON.parse(plan.packages?.manifest ?? '{}').dependencies).toEqual({ 'pi-example-tool': '0.13.0' });
    // The dry-run argv preview never includes package -e entries; they resolve at install time.
    expect(composeArgv(plan.launch).join(' ')).not.toContain('pi-example-tool');
  });

  it('should honor the folder npmCommand as the installer prefix', async () => {
    await addFile('settings.json', JSON.stringify({ packages: ['npm:pi-example-tool'], npmCommand: ['pnpm'] }));
    const plan = await planStart({ dir: agentDir }, deps);
    expect(plan.packages?.installCommand).toEqual(['pnpm', 'install']);
  });
});

describe('planStart alias resolution', () => {
  async function writeAliasSettings(aliasHome: string, name: string, path: string): Promise<void> {
    await mkdir(join(aliasHome, '.cradle'), { recursive: true });
    await writeFile(join(aliasHome, '.cradle', 'settings.json'), JSON.stringify({ agents: { [name]: { path } } }));
  }

  it('should resolve a bare alias name to the same plan as the absolute-path form', async () => {
    const aliasHome = await mkdtemp(join(tmpdir(), 'cradle-alias-home-'));
    await writeAliasSettings(aliasHome, 'my-agent', agentDir);
    try {
      const aliased = await planStart({ dir: 'my-agent' }, { ...deps, home: aliasHome });
      const absolute = await planStart({ dir: agentDir }, deps);
      expect(aliased.extensionsDir).toBe(absolute.extensionsDir);
      expect(aliased.sessionsDir).toBe(absolute.sessionsDir);
      expect(aliased.warnings).toEqual([]);
    } finally {
      await rm(aliasHome, { recursive: true, force: true });
    }
  });

  it('should surface the shadow warning in plan.warnings when a same-named cwd directory also exists', async () => {
    const aliasHome = await mkdtemp(join(tmpdir(), 'cradle-alias-home-'));
    const aliasCwd = await mkdtemp(join(tmpdir(), 'cradle-alias-cwd-'));
    await writeAliasSettings(aliasHome, 'my-agent', agentDir);
    await mkdir(join(aliasCwd, 'my-agent'), { recursive: true });
    try {
      const plan = await planStart({ dir: 'my-agent' }, { ...deps, home: aliasHome, cwd: aliasCwd });
      expect(plan.warnings.join('\n')).toContain('started alias "my-agent"');
    } finally {
      await rm(aliasHome, { recursive: true, force: true });
      await rm(aliasCwd, { recursive: true, force: true });
    }
  });
});

describe('materializeStart packages', () => {
  async function addInstalledPackage(npmDir: string, name: string, manifest: unknown = { name }): Promise<void> {
    const pkgDir = join(npmDir, 'node_modules', name);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify(manifest), 'utf8');
    await writeFile(join(pkgDir, 'index.ts'), '', 'utf8');
  }

  it('should call the installer with the install command and npmDir, then resolve -e entries after the generated providers extension', async () => {
    await addFile('settings.json', JSON.stringify({ packages: ['npm:pi-example-tool'] }));
    await addFile('models.json', JSON.stringify({ providers: { ollama: { baseUrl: 'http://x/v1' } } }));
    const plan = await planStart({ dir: agentDir }, deps);
    const npmDir = plan.packages?.npmDir ?? '';
    const calls: { command: readonly string[]; cwd: string }[] = [];
    const install = async (command: readonly string[], cwd: string): Promise<void> => {
      calls.push({ command, cwd });
      await addInstalledPackage(npmDir, 'pi-example-tool');
    };
    const result = await materializeStart(plan, { install });
    expect(calls).toEqual([{ command: ['npm', 'install'], cwd: npmDir }]);
    const entry = join(npmDir, 'node_modules', 'pi-example-tool', 'index.ts');
    expect(result.argv).toContain(entry);
    expect(result.argv.indexOf(entry)).toBeGreaterThan(result.argv.indexOf(join(plan.extensionsDir, 'providers.ts')));
    expect(result.warnings).toEqual([]);
  });

  it('should skip the install when the manifest is unchanged and node_modules already exists', async () => {
    await addFile('settings.json', JSON.stringify({ packages: ['npm:pi-example-tool'] }));
    const plan = await planStart({ dir: agentDir }, deps);
    const npmDir = plan.packages?.npmDir ?? '';
    await mkdir(npmDir, { recursive: true });
    await writeFile(join(npmDir, 'package.json'), plan.packages?.manifest ?? '', 'utf8');
    await addInstalledPackage(npmDir, 'pi-example-tool');
    let installCalls = 0;
    const install = async (): Promise<void> => {
      installCalls += 1;
    };
    const result = await materializeStart(plan, { install });
    expect(installCalls).toBe(0);
    expect(result.argv).toContain(join(npmDir, 'node_modules', 'pi-example-tool', 'index.ts'));
  });

  it('should reinstall when the manifest changed', async () => {
    await addFile('settings.json', JSON.stringify({ packages: ['npm:pi-example-tool'] }));
    const plan = await planStart({ dir: agentDir }, deps);
    const npmDir = plan.packages?.npmDir ?? '';
    await mkdir(npmDir, { recursive: true });
    await writeFile(join(npmDir, 'package.json'), JSON.stringify({ old: true }), 'utf8');
    await addInstalledPackage(npmDir, 'pi-example-tool');
    let installCalls = 0;
    const install = async (): Promise<void> => {
      installCalls += 1;
    };
    await materializeStart(plan, { install });
    expect(installCalls).toBe(1);
    expect(await readFile(join(npmDir, 'package.json'), 'utf8')).toBe(plan.packages?.manifest ?? '');
  });

  it('should reinstall when node_modules is missing even if the manifest is unchanged', async () => {
    await addFile('settings.json', JSON.stringify({ packages: ['npm:pi-example-tool'] }));
    const plan = await planStart({ dir: agentDir }, deps);
    const npmDir = plan.packages?.npmDir ?? '';
    await mkdir(npmDir, { recursive: true });
    await writeFile(join(npmDir, 'package.json'), plan.packages?.manifest ?? '', 'utf8');
    let installCalls = 0;
    const install = async (): Promise<void> => {
      installCalls += 1;
      await addInstalledPackage(npmDir, 'pi-example-tool');
    };
    await materializeStart(plan, { install });
    expect(installCalls).toBe(1);
  });

  it('should not skip the reinstall after a failed install even though stale node_modules survived', async () => {
    await addFile('settings.json', JSON.stringify({ packages: ['npm:pi-example-tool'] }));
    const plan = await planStart({ dir: agentDir }, deps);
    const npmDir = plan.packages?.npmDir ?? '';
    await mkdir(npmDir, { recursive: true });
    await writeFile(join(npmDir, 'package.json'), JSON.stringify({ old: true }), 'utf8');
    await addInstalledPackage(npmDir, 'pi-example-tool');
    const failing = async (): Promise<void> => {
      throw new Error('network down');
    };
    await expect(materializeStart(plan, { install: failing })).rejects.toThrow('network down');
    // The failed install must not leave the new manifest — with it in place,
    // packagesUpToDate would see manifest-equal + node_modules and skip forever.
    expect(await exists(join(npmDir, 'package.json'))).toBe(false);
    let installCalls = 0;
    const install = async (): Promise<void> => {
      installCalls += 1;
    };
    await materializeStart(plan, { install });
    expect(installCalls).toBe(1);
  });

  it('should return argv === composeArgv(plan.launch) and never call the installer when the folder declares no packages', async () => {
    const plan = await planStart({ dir: agentDir }, deps);
    let installCalls = 0;
    const result = await materializeStart(plan, {
      install: async (): Promise<void> => {
        installCalls += 1;
      }
    });
    expect(result.argv).toEqual(composeArgv(plan.launch));
    expect(installCalls).toBe(0);
  });

  it('should surface resolution warnings when an installed package never lands on disk', async () => {
    await addFile('settings.json', JSON.stringify({ packages: ['npm:pi-example-tool'] }));
    const plan = await planStart({ dir: agentDir }, deps);
    const result = await materializeStart(plan, { install: async (): Promise<void> => {} });
    expect(result.warnings).toEqual(['package pi-example-tool is not installed — skipped']);
  });

  it('should throw a named error when packages are declared but no installer is provided', async () => {
    await addFile('settings.json', JSON.stringify({ packages: ['npm:pi-example-tool'] }));
    const plan = await planStart({ dir: agentDir }, deps);
    await expect(materializeStart(plan)).rejects.toThrow('packages declared but no installer provided');
  });
});

describe('materializeStart', () => {
  it('should write the generated extensions and create the sessions dir', async () => {
    await addFile('models.json', JSON.stringify({ providers: { ollama: { baseUrl: 'http://x/v1' } } }));
    const plan = await planStart({ dir: agentDir }, deps);
    await materializeStart(plan);
    // Assert the on-disk file, not the in-memory plan.files, so a write-time
    // transform would fail here.
    expect(await readdir(plan.extensionsDir)).toEqual(['providers.ts']);
    expect(await readFile(join(plan.extensionsDir, 'providers.ts'), 'utf8')).toContain('registerProvider');
    expect(await readdir(plan.sessionsDir)).toEqual([]);
  });

  it('should write no extensions dir when the agent declares nothing generated', async () => {
    const plan = await planStart({ dir: agentDir }, deps);
    await materializeStart(plan);
    expect(await exists(plan.extensionsDir)).toBe(false);
    expect(await readdir(plan.sessionsDir)).toEqual([]);
  });

  it('should clean stale generated extensions but never touch sessions', async () => {
    await addFile('models.json', JSON.stringify({ providers: { ollama: { baseUrl: 'http://x/v1' } } }));
    const plan = await planStart({ dir: agentDir }, deps);
    await materializeStart(plan);
    await writeFile(join(plan.extensionsDir, 'stale.ts'), 'old', 'utf8');
    await writeFile(join(plan.sessionsDir, 'session.jsonl'), '{}', 'utf8');
    await materializeStart(plan);
    expect(await readdir(plan.extensionsDir)).toEqual(['providers.ts']);
    expect(await readFile(join(plan.sessionsDir, 'session.jsonl'), 'utf8')).toBe('{}');
  });

  it('should be idempotent across repeated runs', async () => {
    await addFile('models.json', JSON.stringify({ providers: { ollama: { baseUrl: 'http://x/v1' } } }));
    const plan = await planStart({ dir: agentDir }, deps);
    await materializeStart(plan);
    await materializeStart(plan);
    expect(await readdir(plan.extensionsDir)).toEqual(['providers.ts']);
  });

  it('should write the generated per-agent profile into the state dir on a sandboxed run', async () => {
    await addFile('sandbox/nono.json', JSON.stringify({ filesystem: { allow: ['~/.agent-browser'] } }));
    const plan = await planStart({ dir: agentDir }, deps);
    await materializeStart(plan);
    const stateDir = stateDirFor(agentDir, '/home/u');
    const written = JSON.parse(await readFile(join(stateDir, 'nono-profile.json'), 'utf8'));
    expect(written.extends).toBe('default');
    // The agent's own grant made it into the generated profile, home-expanded.
    expect(written.filesystem.allow).toContain('/home/u/.agent-browser');
    // …alongside this run's cwd + state dir.
    expect(written.filesystem.allow).toEqual(expect.arrayContaining(['/work', stateDir]));
  });

  it('should not write any profile on an unsandboxed run', async () => {
    const which = createWhichStub({ pi: '/shims/pi' });
    const plan = await planStart({ dir: agentDir, noSandbox: true }, { ...deps, which });
    await materializeStart(plan);
    // materializeStart created the state dir (extensions + sessions) but no profile.
    expect(await readdir(stateDirFor(agentDir, '/home/u'))).not.toContain('nono-profile.json');
  });

  it('should throw a named error when the extensions dir cannot be written', async () => {
    const plan = await planStart({ dir: agentDir }, deps);
    const blocker = join(root, 'blocker');
    await writeFile(blocker, '', 'utf8');
    await expect(materializeStart({ ...plan, extensionsDir: join(blocker, 'extensions') })).rejects.toThrow(
      'failed to write agent extensions'
    );
  });
});
