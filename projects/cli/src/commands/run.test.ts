import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import { exists, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeArgv } from '../agent/launch.js';
import { stateDirFor } from '../agent/state.js';
import { createWhichStub } from '../util/which.js';
import { materializeRun, planRun } from './run.js';

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
const agentBrowserNonoFallbackFile = 'agent-browser-nono-fallback.ts';

describe('planRun', () => {
  it('should compose a sandboxed plan with the resolved nono, including --silent by default', async () => {
    const plan = await planRun({ dir: agentDir }, deps);
    const stateDir = stateDirFor(agentDir, '/home/u');
    const profilePath = join(stateDir, 'nono-profile.json');
    expect(composeArgv(plan.launch)[0]).toBe('/shims/nono');
    // Grants live in the profile now; the wrapper just points nono at it.
    // --silent suppresses nono's startup banner by default.
    expect(composeArgv(plan.launch)).not.toContain('--allow');
    expect(composeArgv(plan.launch).slice(0, 5)).toEqual(['/shims/nono', 'run', '--silent', '--profile', profilePath]);
    expect(plan.extensionsDir).toBe(join(stateDir, 'extensions'));
    expect(plan.sessionsDir).toBe(join(stateDir, 'sessions'));
    expect(plan.launch.miseCacheDir).toBe(join(stateDir, 'mise-cache'));
    expect(relFiles(plan)).toEqual([agentBrowserNonoFallbackFile]);
    expect(composeArgv(plan.launch)).toContain(join(plan.extensionsDir, agentBrowserNonoFallbackFile));
    expect(plan.profile?.path).toBe(profilePath);
    expect(JSON.parse(plan.profile?.content ?? '{}').extends).toBe('default');
    expect(plan.dryRun).toBe(false);
  });

  it('should run unsandboxed and warn when sandbox/nono.json is absent', async () => {
    await rm(join(agentDir, 'sandbox'), { recursive: true });
    const plan = await planRun({ dir: agentDir }, { ...deps, which: createWhichStub({ pi: '/shims/pi' }) });
    expect(composeArgv(plan.launch)[0]).toBe('/shims/pi');
    expect(plan.profile).toBeNull();
    expect(relFiles(plan)).toEqual([]);
    expect(plan.warnings.join('\n')).toContain('sandbox/nono.json or sbx.json not found');
  });

  it('should omit --silent when verbose is true', async () => {
    const plan = await planRun({ dir: agentDir, verbose: true }, deps);
    const stateDir = stateDirFor(agentDir, '/home/u');
    const profilePath = join(stateDir, 'nono-profile.json');
    expect(composeArgv(plan.launch).slice(0, 4)).toEqual(['/shims/nono', 'run', '--profile', profilePath]);
    expect(composeArgv(plan.launch)).not.toContain('--silent');
  });

  it('should skip bin checks on dry-run and keep the bare nono name', async () => {
    const throwingWhich = () => {
      throw new Error('The which lookup must not be called on dry-run');
    };
    const plan = await planRun({ dir: agentDir, dryRun: true }, { ...deps, which: throwingWhich });
    expect(composeArgv(plan.launch)[0]).toBe('nono');
    expect(plan.dryRun).toBe(true);
  });

  it('should require pi even when unsandboxed', async () => {
    const which = createWhichStub({ nono: '/shims/nono' });
    await expect(planRun({ dir: agentDir, noSandbox: true }, { ...deps, which })).rejects.toThrow(
      'Required executable "pi"'
    );
  });

  it('should not require nono when unsandboxed', async () => {
    const which = createWhichStub({ pi: '/shims/pi' });
    const plan = await planRun({ dir: agentDir, noSandbox: true }, { ...deps, which });
    expect(composeArgv(plan.launch)[0]).toBe('/shims/pi');
    expect(composeArgv(plan.launch)).not.toContain('nono');
    // No sandbox → no nono profile to generate.
    expect(plan.profile).toBeNull();
  });

  it('should spawn the resolved pi path (mise-shim fallback included) instead of the bare name, sandboxed and unsandboxed', async () => {
    const shimPi = '/home/u/.local/share/mise/shims/pi';
    const sandboxed = await planRun(
      { dir: agentDir },
      { ...deps, which: createWhichStub({ nono: '/shims/nono', pi: shimPi }) }
    );
    const sandboxedArgv = composeArgv(sandboxed.launch);
    expect(sandboxedArgv[sandboxedArgv.indexOf('--') + 1]).toBe(shimPi);
    const unsandboxed = await planRun(
      { dir: agentDir, noSandbox: true },
      { ...deps, which: createWhichStub({ pi: shimPi }) }
    );
    expect(composeArgv(unsandboxed.launch)[0]).toBe(shimPi);
  });

  it('should emit the providers extension only when the agent defines models.json', async () => {
    await addFile('models.json', JSON.stringify({ providers: { ollama: { baseUrl: 'http://x/v1' } } }));
    const plan = await planRun({ dir: agentDir }, deps);
    expect(relFiles(plan)).toEqual(['providers.ts', agentBrowserNonoFallbackFile]);
    expect(composeArgv(plan.launch)).toContain(join(plan.extensionsDir, 'providers.ts'));
  });

  it('should pass agent extensions/ files straight through after the sandbox fallback', async () => {
    await addFile('extensions/flip.ts', 'export default function () {};\n');
    const plan = await planRun({ dir: agentDir }, deps);
    expect(relFiles(plan)).toEqual([agentBrowserNonoFallbackFile]);
    const argv = composeArgv(plan.launch);
    expect(argv.indexOf(join(plan.extensionsDir, agentBrowserNonoFallbackFile))).toBeLessThan(
      argv.indexOf(join(agentDir, 'extensions', 'flip.ts'))
    );
  });

  const profileNetwork = (plan: { profile?: { content: string } | null }) =>
    JSON.parse(plan.profile?.content ?? '{}').network;

  it('should bake the folder network block into the generated profile, canonical keys', async () => {
    await addFile(
      'sandbox/nono.json',
      JSON.stringify({ network: { allow_domain: ['api.example.com'], open_port: [11434] } })
    );
    const plan = await planRun({ dir: agentDir }, deps);
    expect(profileNetwork(plan)).toEqual({ allow_domain: ['api.example.com'], open_port: [11434] });
    // Network no longer rides as a flag.
    expect(composeArgv(plan.launch)).not.toContain('--block-net');
  });

  it('should omit the network block entirely when no policy is set (nono default: open)', async () => {
    const plan = await planRun({ dir: agentDir }, deps);
    expect(profileNetwork(plan)).toBeUndefined();
  });

  it('should resolve network precedence as --offline > --allow-host > folder > open', async () => {
    await addFile('sandbox/nono.json', JSON.stringify({ network: { allow_domain: ['folder.example'] } }));
    // Folder wins with no flags.
    expect(profileNetwork(await planRun({ dir: agentDir }, deps))).toEqual({ allow_domain: ['folder.example'] });
    // --allow-host overrides the folder allowlist.
    const allowHost = await planRun({ dir: agentDir, allowHost: ['api.example.com', 'localhost'] }, deps);
    expect(profileNetwork(allowHost)).toEqual({ allow_domain: ['api.example.com', 'localhost'] });
    // --offline overrides everything.
    const offline = await planRun({ dir: agentDir, offline: true, allowHost: ['api.example.com'] }, deps);
    expect(profileNetwork(offline)).toEqual({ block: true });
  });

  it('should trim leading/trailing whitespace from --allow-host entries', async () => {
    const plan = await planRun({ dir: agentDir, allowHost: [' api.example.com ', 'localhost'] }, deps);
    expect(profileNetwork(plan)).toEqual({ allow_domain: ['api.example.com', 'localhost'] });
    expect(plan.warnings.join('\n')).not.toContain('--allow-host');
  });

  it('should drop a whitespace-only --allow-host entry and warn', async () => {
    const plan = await planRun({ dir: agentDir, allowHost: ['api.example.com', '   '] }, deps);
    expect(profileNetwork(plan)).toEqual({ allow_domain: ['api.example.com'] });
    expect(plan.warnings.join('\n')).toContain('--allow-host entries must be non-empty — blanks ignored');
  });

  it('should fall back to the folder network when every --allow-host entry is blank', async () => {
    await addFile('sandbox/nono.json', JSON.stringify({ network: { allow_domain: ['folder.example'] } }));
    const plan = await planRun({ dir: agentDir, allowHost: ['   '] }, deps);
    expect(profileNetwork(plan)).toEqual({ allow_domain: ['folder.example'] });
    expect(plan.warnings.join('\n')).toContain('--allow-host entries must be non-empty — blanks ignored');
  });

  it('should bake the network posture into the profile, disclosed by nono not cradle', async () => {
    await addFile('sandbox/nono.json', JSON.stringify({ network: { allow_domain: ['api.example.com', 'localhost'] } }));
    const sandboxed = await planRun({ dir: agentDir }, deps);
    expect(JSON.parse(sandboxed.profile?.content ?? '{}').network).toEqual({
      allow_domain: ['api.example.com', 'localhost']
    });
    // Unsandboxed runs generate no profile.
    const bare = await planRun(
      { dir: agentDir, noSandbox: true },
      { ...deps, which: createWhichStub({ pi: '/shims/pi' }) }
    );
    expect(bare.profile).toBeNull();
  });

  it('should warn that a restrictive network policy is unenforced on an unsandboxed run', async () => {
    const which = createWhichStub({ pi: '/shims/pi' });
    const plan = await planRun({ dir: agentDir, offline: true, noSandbox: true }, { ...deps, which });
    expect(plan.warnings.join('\n')).toContain('network policy has no effect without the sandbox');
    // A merely-permissive posture (ports only) does NOT trigger the warning.
    await addFile('sandbox/nono.json', JSON.stringify({ network: { open_port: [8080] } }));
    const permissive = await planRun({ dir: agentDir, noSandbox: true }, { ...deps, which });
    expect(permissive.warnings.join('\n')).not.toContain('network policy has no effect');
  });

  it('should propagate folder warnings and forward passthrough last', async () => {
    await addFile('notes.txt', '');
    const plan = await planRun({ dir: agentDir, passthrough: ['-p', 'hi'] }, deps);
    expect(plan.warnings.join('\n')).toContain('notes.txt');
    expect(composeArgv(plan.launch).slice(-2)).toEqual(['-p', 'hi']);
  });

  it('should bake the agent filesystem grants into the profile, disclosed by nono not cradle', async () => {
    await addFile(
      'sandbox/nono.json',
      JSON.stringify({
        filesystem: {
          read: ['~/data'],
          allow: ['/scratch'],
          unix_socket_dir_bind: ['~/.agent-browser']
        }
      })
    );
    const sandboxed = await planRun({ dir: agentDir }, deps);
    const profile = JSON.parse(sandboxed.profile?.content ?? '{}');
    expect(profile.filesystem.read).toContain('/home/u/data');
    expect(profile.filesystem.allow).toContain('/scratch');
    expect(profile.filesystem.unix_socket_dir_bind).toEqual(['/home/u/.agent-browser']);
  });

  it('should bake the agent seatbelt rules into the profile', async () => {
    const rules = ['(allow mach-register)', '(allow iokit-open)'];
    await addFile('sandbox/nono.json', JSON.stringify({ unsafe_macos_seatbelt_rules: rules }));
    const sandboxed = await planRun({ dir: agentDir }, deps);
    // Rules land after the base rules in the generated profile (last-match-wins).
    const profileRules = JSON.parse(sandboxed.profile?.content ?? '{}').unsafe_macos_seatbelt_rules;
    expect(profileRules.slice(-2)).toEqual(rules);
    // Unsandboxed runs generate no profile.
    const bare = await planRun({ dir: agentDir, noSandbox: true }, deps);
    expect(bare.profile).toBeNull();
  });

  it('should honor a folder sandbox opt-out with a loud warning and no nono requirement', async () => {
    await addFile('sandbox/nono.json', JSON.stringify({ sandbox: false }));
    // Only pi on PATH — nono must not be required when the folder opts out.
    const which = createWhichStub({ pi: '/shims/pi' });
    const plan = await planRun({ dir: agentDir }, { ...deps, which });
    expect(composeArgv(plan.launch)[0]).toBe('/shims/pi');
    expect(plan.profile).toBeNull();
    expect(plan.warnings.join('\n')).toContain('sandbox disabled by sandbox/nono.json');
  });

  it('should let an explicit --sandbox override the folder opt-out, without the opt-out warning', async () => {
    await addFile('sandbox/nono.json', JSON.stringify({ sandbox: false, filesystem: { allow: ['~/scratch'] } }));
    const plan = await planRun({ dir: agentDir, noSandbox: false }, deps);
    expect(composeArgv(plan.launch)[0]).toBe('/shims/nono');
    expect(plan.profile).not.toBeNull();
    // The folder's grants still apply when the sandbox is forced back on.
    expect(JSON.parse(plan.profile?.content ?? '{}').filesystem.allow).toContain('/home/u/scratch');
    expect(plan.warnings.join('\n')).not.toContain('sandbox disabled');
  });

  it('should not warn about the folder opt-out when --no-sandbox was the user’s own choice', async () => {
    await addFile('sandbox/nono.json', JSON.stringify({ sandbox: false }));
    const which = createWhichStub({ pi: '/shims/pi' });
    const plan = await planRun({ dir: agentDir, noSandbox: true }, { ...deps, which });
    expect(composeArgv(plan.launch)[0]).toBe('/shims/pi');
    expect(plan.warnings.join('\n')).not.toContain('sandbox disabled');
  });

  it('should force sandboxing on with --sandbox when sandbox/nono.json is absent', async () => {
    await rm(join(agentDir, 'sandbox'), { recursive: true });
    const plan = await planRun({ dir: agentDir, noSandbox: false }, deps);
    expect(composeArgv(plan.launch)[0]).toBe('/shims/nono');
    expect(plan.profile).not.toBeNull();
  });

  it('should force sandboxing on with --offline when sandbox/nono.json is absent', async () => {
    await rm(join(agentDir, 'sandbox'), { recursive: true });
    const plan = await planRun({ dir: agentDir, offline: true }, deps);
    expect(composeArgv(plan.launch)[0]).toBe('/shims/nono');
    expect(JSON.parse(plan.profile?.content ?? '{}').network).toMatchObject({ block: true });
    expect(plan.warnings.join('\n')).toContain('sandbox forced on to enforce the requested network policy');
  });

  it('should force sandboxing on with --allow-host when sandbox/nono.json is absent', async () => {
    await rm(join(agentDir, 'sandbox'), { recursive: true });
    const plan = await planRun({ dir: agentDir, allowHost: ['registry.npmjs.org'] }, deps);
    expect(composeArgv(plan.launch)[0]).toBe('/shims/nono');
    expect(JSON.parse(plan.profile?.content ?? '{}').network.allow_domain).toContain('registry.npmjs.org');
    expect(plan.warnings.join('\n')).toContain('sandbox forced on to enforce the requested network policy');
  });

  it('should force sandboxing on with --offline even when the folder opts out, citing the opt-out reason', async () => {
    await addFile('sandbox/nono.json', JSON.stringify({ sandbox: false }));
    const plan = await planRun({ dir: agentDir, offline: true }, deps);
    expect(composeArgv(plan.launch)[0]).toBe('/shims/nono');
    expect(JSON.parse(plan.profile?.content ?? '{}').network).toMatchObject({ block: true });
    expect(plan.warnings.join('\n')).toContain(
      'sandbox disabled by sandbox/nono.json — sandbox forced on to enforce the requested network policy'
    );
  });

  it('should stay unsandboxed and warn with the new message when --no-sandbox overrides --offline', async () => {
    const which = createWhichStub({ pi: '/shims/pi' });
    const plan = await planRun({ dir: agentDir, noSandbox: true, offline: true }, { ...deps, which });
    expect(composeArgv(plan.launch)[0]).toBe('/shims/pi');
    expect(plan.warnings.join('\n')).toContain('network policy has no effect without the sandbox');
  });

  it('should keep the sandbox/ has no nono.json loader warning even when --sandbox is explicit', async () => {
    await rm(join(agentDir, 'sandbox', 'nono.json'));
    const plan = await planRun({ dir: agentDir, noSandbox: false }, deps);
    expect(plan.warnings.join('\n')).toContain('sandbox/ has no nono.json');
  });

  it('should leave packages null when the folder declares none', async () => {
    const plan = await planRun({ dir: agentDir }, deps);
    expect(plan.packages).toBeNull();
  });

  it('should build a packages plan when settings.json declares packages', async () => {
    await addFile('settings.json', JSON.stringify({ packages: ['npm:pi-example-tool@0.13.0'] }));
    const plan = await planRun({ dir: agentDir }, deps);
    const stateDir = stateDirFor(agentDir, '/home/u');
    expect(plan.packages?.npmDir).toBe(join(stateDir, 'npm'));
    expect(plan.packages?.specs).toEqual([{ name: 'pi-example-tool', version: '0.13.0' }]);
    expect(plan.packages?.installCommand).toEqual(['npm', 'install', '--ignore-scripts']);
    expect(JSON.parse(plan.packages?.manifest ?? '{}').dependencies).toEqual({ 'pi-example-tool': '0.13.0' });
    // The dry-run argv preview never includes package -e entries; they resolve at install time.
    expect(composeArgv(plan.launch).join(' ')).not.toContain('pi-example-tool');
  });

  it('should honor the folder npmCommand as the installer prefix', async () => {
    await addFile('settings.json', JSON.stringify({ packages: ['npm:pi-example-tool'], npmCommand: ['pnpm'] }));
    const plan = await planRun({ dir: agentDir }, deps);
    expect(plan.packages?.installCommand).toEqual(['pnpm', 'install', '--ignore-scripts']);
  });

  it('should append --ignore-scripts to the composed install command so a folder-declared package cannot run postinstall scripts on the host', async () => {
    await addFile('settings.json', JSON.stringify({ packages: ['npm:pi-example-tool'] }));
    const plan = await planRun({ dir: agentDir }, deps);
    expect(plan.packages?.installCommand.slice(-2)).toEqual(['install', '--ignore-scripts']);
  });
});

describe('planRun alias resolution', () => {
  async function writeAliasSettings(aliasHome: string, name: string, path: string): Promise<void> {
    await mkdir(join(aliasHome, '.cradle'), { recursive: true });
    await writeFile(join(aliasHome, '.cradle', 'settings.json'), JSON.stringify({ agents: { [name]: { path } } }));
  }

  it('should resolve a bare alias name to the same plan as the absolute-path form', async () => {
    const aliasHome = await mkdtemp(join(tmpdir(), 'cradle-alias-home-'));
    await writeAliasSettings(aliasHome, 'my-agent', agentDir);
    try {
      const aliased = await planRun({ dir: 'my-agent' }, { ...deps, home: aliasHome });
      const absolute = await planRun({ dir: agentDir }, deps);
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
      const plan = await planRun({ dir: 'my-agent' }, { ...deps, home: aliasHome, cwd: aliasCwd });
      expect(plan.warnings.join('\n')).toContain('started alias "my-agent"');
    } finally {
      await rm(aliasHome, { recursive: true, force: true });
      await rm(aliasCwd, { recursive: true, force: true });
    }
  });
});

describe('materializeRun packages', () => {
  async function addInstalledPackage(npmDir: string, name: string, manifest: unknown = { name }): Promise<void> {
    const pkgDir = join(npmDir, 'node_modules', name);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify(manifest), 'utf8');
    await writeFile(join(pkgDir, 'index.ts'), '', 'utf8');
  }

  it('should call the installer with the install command and npmDir, then resolve -e entries after generated extensions', async () => {
    await addFile('settings.json', JSON.stringify({ packages: ['npm:pi-example-tool'] }));
    await addFile('models.json', JSON.stringify({ providers: { ollama: { baseUrl: 'http://x/v1' } } }));
    const plan = await planRun({ dir: agentDir }, deps);
    const npmDir = plan.packages?.npmDir ?? '';
    const calls: { command: readonly string[]; cwd: string }[] = [];
    const install = async (command: readonly string[], cwd: string): Promise<void> => {
      calls.push({ command, cwd });
      await addInstalledPackage(npmDir, 'pi-example-tool');
    };
    const result = await materializeRun(plan, { install });
    expect(calls).toEqual([{ command: ['npm', 'install', '--ignore-scripts'], cwd: npmDir }]);
    const entry = join(npmDir, 'node_modules', 'pi-example-tool', 'index.ts');
    expect(result.argv).toContain(entry);
    expect(result.argv.indexOf(entry)).toBeGreaterThan(
      result.argv.indexOf(join(plan.extensionsDir, agentBrowserNonoFallbackFile))
    );
    expect(result.warnings).toEqual([]);
  });

  it('should skip the install when the manifest is unchanged and node_modules already exists', async () => {
    await addFile('settings.json', JSON.stringify({ packages: ['npm:pi-example-tool'] }));
    const plan = await planRun({ dir: agentDir }, deps);
    const npmDir = plan.packages?.npmDir ?? '';
    await mkdir(npmDir, { recursive: true });
    await writeFile(join(npmDir, 'package.json'), plan.packages?.manifest ?? '', 'utf8');
    await addInstalledPackage(npmDir, 'pi-example-tool');
    let installCalls = 0;
    const install = async (): Promise<void> => {
      installCalls += 1;
    };
    const result = await materializeRun(plan, { install });
    expect(installCalls).toBe(0);
    expect(result.argv).toContain(join(npmDir, 'node_modules', 'pi-example-tool', 'index.ts'));
  });

  it('should reinstall when the manifest changed', async () => {
    await addFile('settings.json', JSON.stringify({ packages: ['npm:pi-example-tool'] }));
    const plan = await planRun({ dir: agentDir }, deps);
    const npmDir = plan.packages?.npmDir ?? '';
    await mkdir(npmDir, { recursive: true });
    await writeFile(join(npmDir, 'package.json'), JSON.stringify({ old: true }), 'utf8');
    await addInstalledPackage(npmDir, 'pi-example-tool');
    let installCalls = 0;
    const install = async (): Promise<void> => {
      installCalls += 1;
    };
    await materializeRun(plan, { install });
    expect(installCalls).toBe(1);
    expect(await readFile(join(npmDir, 'package.json'), 'utf8')).toBe(plan.packages?.manifest ?? '');
  });

  it('should reinstall when node_modules is missing even if the manifest is unchanged', async () => {
    await addFile('settings.json', JSON.stringify({ packages: ['npm:pi-example-tool'] }));
    const plan = await planRun({ dir: agentDir }, deps);
    const npmDir = plan.packages?.npmDir ?? '';
    await mkdir(npmDir, { recursive: true });
    await writeFile(join(npmDir, 'package.json'), plan.packages?.manifest ?? '', 'utf8');
    let installCalls = 0;
    const install = async (): Promise<void> => {
      installCalls += 1;
      await addInstalledPackage(npmDir, 'pi-example-tool');
    };
    await materializeRun(plan, { install });
    expect(installCalls).toBe(1);
  });

  it('should not skip the reinstall after a failed install even though stale node_modules survived', async () => {
    await addFile('settings.json', JSON.stringify({ packages: ['npm:pi-example-tool'] }));
    const plan = await planRun({ dir: agentDir }, deps);
    const npmDir = plan.packages?.npmDir ?? '';
    await mkdir(npmDir, { recursive: true });
    await writeFile(join(npmDir, 'package.json'), JSON.stringify({ old: true }), 'utf8');
    await addInstalledPackage(npmDir, 'pi-example-tool');
    const failing = async (): Promise<void> => {
      throw new Error('Network down');
    };
    await expect(materializeRun(plan, { install: failing })).rejects.toThrow('Network down');
    // The failed install must not leave the new manifest — with it in place,
    // packagesUpToDate would see manifest-equal + node_modules and skip forever.
    expect(await exists(join(npmDir, 'package.json'))).toBe(false);
    let installCalls = 0;
    const install = async (): Promise<void> => {
      installCalls += 1;
    };
    await materializeRun(plan, { install });
    expect(installCalls).toBe(1);
  });

  it('should return argv === composeArgv(plan.launch) and never call the installer when the folder declares no packages', async () => {
    const plan = await planRun({ dir: agentDir }, deps);
    let installCalls = 0;
    const result = await materializeRun(plan, {
      install: async (): Promise<void> => {
        installCalls += 1;
      }
    });
    expect(result.argv).toEqual(composeArgv(plan.launch));
    expect(installCalls).toBe(0);
  });

  it('should surface resolution warnings when an installed package never lands on disk', async () => {
    await addFile('settings.json', JSON.stringify({ packages: ['npm:pi-example-tool'] }));
    const plan = await planRun({ dir: agentDir }, deps);
    const result = await materializeRun(plan, { install: async (): Promise<void> => {} });
    expect(result.warnings).toEqual(['package pi-example-tool is not installed — skipped']);
  });

  it('should throw a named error when packages are declared but no installer is provided', async () => {
    await addFile('settings.json', JSON.stringify({ packages: ['npm:pi-example-tool'] }));
    const plan = await planRun({ dir: agentDir }, deps);
    await expect(materializeRun(plan)).rejects.toThrow('Packages declared but no installer provided');
  });
});

describe('materializeRun', () => {
  it('should write the generated extensions and create the sessions dir', async () => {
    await addFile('models.json', JSON.stringify({ providers: { ollama: { baseUrl: 'http://x/v1' } } }));
    const plan = await planRun({ dir: agentDir }, deps);
    await materializeRun(plan);
    // Assert the on-disk file, not the in-memory plan.files, so a write-time
    // transform would fail here.
    expect((await readdir(plan.extensionsDir)).sort()).toEqual([agentBrowserNonoFallbackFile, 'providers.ts'].sort());
    expect(await readFile(join(plan.extensionsDir, 'providers.ts'), 'utf8')).toContain('registerProvider');
    expect(await readFile(join(plan.extensionsDir, agentBrowserNonoFallbackFile), 'utf8')).toContain(
      'AGENT_BROWSER_PROXY'
    );
    expect(await readdir(plan.sessionsDir)).toEqual([]);
  });

  it('should write no extensions dir when an unsandboxed agent declares nothing generated', async () => {
    const plan = await planRun(
      { dir: agentDir, noSandbox: true },
      { ...deps, which: createWhichStub({ pi: '/shims/pi' }) }
    );
    await materializeRun(plan);
    expect(await exists(plan.extensionsDir)).toBe(false);
    expect(await readdir(plan.sessionsDir)).toEqual([]);
  });

  it('should clean stale generated extensions but never touch sessions', async () => {
    await addFile('models.json', JSON.stringify({ providers: { ollama: { baseUrl: 'http://x/v1' } } }));
    const plan = await planRun({ dir: agentDir }, deps);
    await materializeRun(plan);
    await writeFile(join(plan.extensionsDir, 'stale.ts'), 'old', 'utf8');
    await writeFile(join(plan.sessionsDir, 'session.jsonl'), '{}', 'utf8');
    await materializeRun(plan);
    expect((await readdir(plan.extensionsDir)).sort()).toEqual([agentBrowserNonoFallbackFile, 'providers.ts'].sort());
    expect(await readFile(join(plan.sessionsDir, 'session.jsonl'), 'utf8')).toBe('{}');
  });

  it('should be idempotent across repeated runs', async () => {
    await addFile('models.json', JSON.stringify({ providers: { ollama: { baseUrl: 'http://x/v1' } } }));
    const plan = await planRun({ dir: agentDir }, deps);
    await materializeRun(plan);
    await materializeRun(plan);
    expect((await readdir(plan.extensionsDir)).sort()).toEqual([agentBrowserNonoFallbackFile, 'providers.ts'].sort());
  });

  it('should write the generated per-agent profile into the state dir on a sandboxed run', async () => {
    await addFile(
      'sandbox/nono.json',
      JSON.stringify({
        filesystem: {
          allow: ['~/.agent-browser'],
          unix_socket_dir_bind: ['~/.agent-browser']
        }
      })
    );
    const plan = await planRun({ dir: agentDir }, deps);
    await materializeRun(plan);
    const stateDir = stateDirFor(agentDir, '/home/u');
    const written = JSON.parse(await readFile(join(stateDir, 'nono-profile.json'), 'utf8'));
    expect(written.extends).toBe('default');
    expect(written.filesystem.allow).toContain('/home/u/.agent-browser');
    expect(written.filesystem.unix_socket_dir_bind).toEqual(['/home/u/.agent-browser']);
    expect(written.filesystem.allow).toEqual(expect.arrayContaining(['/work', stateDir]));
  });

  it('should not write any profile on an unsandboxed run', async () => {
    const which = createWhichStub({ pi: '/shims/pi' });
    const plan = await planRun({ dir: agentDir, noSandbox: true }, { ...deps, which });
    await materializeRun(plan);
    // materializeRun created the state and sessions dirs but no profile.
    expect(await readdir(stateDirFor(agentDir, '/home/u'))).not.toContain('nono-profile.json');
  });

  it('should throw a named error when the extensions dir cannot be written', async () => {
    const plan = await planRun({ dir: agentDir }, deps);
    const blocker = join(root, 'blocker');
    await writeFile(blocker, '', 'utf8');
    await expect(materializeRun({ ...plan, extensionsDir: join(blocker, 'extensions') })).rejects.toThrow(
      'Failed to write agent extensions'
    );
  });

  it('should keep the composed argv consistent with an overridden plan.extensionsDir/sessionsDir', async () => {
    await addFile('models.json', JSON.stringify({ providers: { ollama: { baseUrl: 'http://x/v1' } } }));
    const plan = await planRun({ dir: agentDir }, deps);
    const overriddenExtensionsDir = join(root, 'custom-extensions');
    const overriddenSessionsDir = join(root, 'custom-sessions');
    const overridden = { ...plan, extensionsDir: overriddenExtensionsDir, sessionsDir: overriddenSessionsDir };
    const result = await materializeRun(overridden);
    // Files land in the overridden dirs (materializeRun writes to plan.extensionsDir directly)...
    expect((await readdir(overriddenExtensionsDir)).sort()).toEqual(
      [agentBrowserNonoFallbackFile, 'providers.ts'].sort()
    );
    // ...and the composed argv agrees, rather than pointing at the plan's original dirs.
    expect(result.argv).toContain(join(overriddenExtensionsDir, 'providers.ts'));
    expect(result.argv).toContain(join(overriddenExtensionsDir, agentBrowserNonoFallbackFile));
    expect(result.argv[result.argv.indexOf('--session-dir') + 1]).toBe(overriddenSessionsDir);
    expect(result.argv).not.toContain(join(plan.extensionsDir, 'providers.ts'));
    expect(result.argv).not.toContain(plan.sessionsDir);
  });
});

describe('planRun sandbox cwd guard', () => {
  it('should refuse to sandbox from the home directory with a friendly error naming the path', async () => {
    await expect(planRun({ dir: agentDir }, { ...deps, cwd: '/home/u', home: '/home/u' })).rejects.toThrow(
      'cannot sandbox from /home/u'
    );
  });

  it('should refuse to sandbox from an ancestor of the home directory (e.g. /Users)', async () => {
    await expect(planRun({ dir: agentDir }, { ...deps, cwd: '/home', home: '/home/u' })).rejects.toThrow(
      'cannot sandbox from /home'
    );
  });

  it('should refuse to sandbox from a directory that itself contains nono’s protected state root', async () => {
    await expect(planRun({ dir: agentDir }, { ...deps, cwd: '/home/u/.local', home: '/home/u' })).rejects.toThrow(
      'cannot sandbox from /home/u/.local'
    );
  });

  it('should leave a normal project cwd unaffected', async () => {
    const plan = await planRun({ dir: agentDir }, deps); // deps.cwd = '/work', deps.home = '/home/u'
    expect(plan.profile).not.toBeNull();
  });

  it('should not apply the guard to an unsandboxed run from the home directory', async () => {
    const which = createWhichStub({ pi: '/shims/pi' });
    const plan = await planRun({ dir: agentDir, noSandbox: true }, { ...deps, which, cwd: '/home/u', home: '/home/u' });
    expect(plan.profile).toBeNull();
    expect(composeArgv(plan.launch)[0]).toBe('/shims/pi');
  });
});

describe('planRun linked git dir', () => {
  let cwdRoot: string;
  beforeEach(async () => {
    cwdRoot = await mkdtemp(join(tmpdir(), 'cradle-linked-git-cwd-'));
  });
  afterEach(async () => {
    await rm(cwdRoot, { recursive: true, force: true });
  });

  it('should grant the resolved main git dir when cwd is a linked worktree, and skip the resolve entirely when unsandboxed', async () => {
    const worktreeCwd = join(cwdRoot, 'wt');
    const mainGitDir = join(cwdRoot, 'main', '.git');
    const worktreeGitDir = join(mainGitDir, 'worktrees', 'wt');
    await mkdir(worktreeCwd, { recursive: true });
    await mkdir(worktreeGitDir, { recursive: true });
    await writeFile(join(worktreeGitDir, 'commondir'), '../..\n', 'utf8');
    await writeFile(join(worktreeCwd, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8');

    const plan = await planRun({ dir: agentDir }, { ...deps, cwd: worktreeCwd });
    expect(JSON.parse(plan.profile?.content ?? '{}').filesystem.allow).toContain(mainGitDir);

    // Unsandboxed runs generate no profile — the linked-git-dir resolve never mattered.
    const bare = await planRun(
      { dir: agentDir, noSandbox: true },
      { ...deps, which: createWhichStub({ pi: '/shims/pi' }), cwd: worktreeCwd }
    );
    expect(bare.profile).toBeNull();
  });

  it('should grant only cwd + state dir + base entries when cwd has no linked git dir', async () => {
    const plainCwd = join(cwdRoot, 'plain');
    await mkdir(plainCwd, { recursive: true });
    const stateDir = stateDirFor(agentDir, '/home/u');
    const plan = await planRun({ dir: agentDir }, { ...deps, cwd: plainCwd });
    expect(JSON.parse(plan.profile?.content ?? '{}').filesystem.allow).toEqual(['$HOME/.pi/agent', plainCwd, stateDir]);
  });
});

describe('sbx backend', () => {
  const sbxDeps = { ...deps, which: createWhichStub({ pi: '/shims/pi', sbx: '/shims/sbx' }) };

  beforeEach(async () => {
    await rm(join(agentDir, 'sandbox'), { recursive: true });
    await addFile('sandbox/sbx.json', '{}');
  });

  it('should resolve the sbx backend from sandbox/sbx.json alone, with no nono profile and no missing-file warning', async () => {
    const plan = await planRun({ dir: agentDir }, sbxDeps);
    expect(plan.launch.backend).toBe('sbx');
    expect(plan.sbx).not.toBeNull();
    expect(plan.profile).toBeNull();
    expect(plan.warnings.join('\n')).not.toContain('not found');
  });

  it('should prefer nono when both files are enabled, warning about the tie-break', async () => {
    await addFile('sandbox/nono.json', '{}');
    const plan = await planRun(
      { dir: agentDir },
      { ...deps, which: createWhichStub({ ...allBins, sbx: '/shims/sbx' }) }
    );
    expect(plan.launch.backend).toBe('nono');
    expect(plan.warnings.join('\n')).toContain('using nono (pass --sandbox-backend sbx to override)');
  });

  it('should let --sandbox-backend sbx override a nono-declaring folder, without the tie-break warning', async () => {
    await addFile('sandbox/nono.json', '{}');
    const plan = await planRun({ dir: agentDir, sandboxBackend: 'sbx' }, sbxDeps);
    expect(plan.launch.backend).toBe('sbx');
    expect(plan.profile).toBeNull();
    expect(plan.sbx).not.toBeNull();
    // The explicit flag resolves the tie itself — warning about it would be noise.
    expect(plan.warnings.join('\n')).not.toContain('using nono');
  });

  it('should let --no-sandbox beat --sandbox-backend', async () => {
    const plan = await planRun(
      { dir: agentDir, sandboxBackend: 'sbx', noSandbox: true },
      { ...sbxDeps, which: createWhichStub({ pi: '/shims/pi' }) }
    );
    expect(plan.launch.backend).toBeNull();
    expect(plan.sbx).toBeNull();
  });

  it('should cite the sbx opt-out when sbx.json disables the sandbox', async () => {
    await addFile('sandbox/sbx.json', JSON.stringify({ sandbox: false }));
    const plan = await planRun({ dir: agentDir }, { ...deps, which: createWhichStub({ pi: '/shims/pi' }) });
    expect(plan.launch.backend).toBeNull();
    expect(plan.warnings.join('\n')).toContain('sandbox disabled by sandbox/sbx.json');
  });

  it('should force sbx on with --offline when only sbx.json is present, emitting the deny-all policy', async () => {
    const plan = await planRun({ dir: agentDir, offline: true }, sbxDeps);
    expect(plan.launch.backend).toBe('sbx');
    expect(plan.sbx?.policyArgvs).toEqual([
      ['/shims/sbx', 'policy', 'deny', 'network', '--sandbox', plan.sbx?.spec.name ?? '', '**']
    ]);
  });

  it('should compose the mount set (cwd rw, agent dir ro, state dir rw, ~/.pi/agent rw) and a mount-hashed name', async () => {
    const plan = await planRun({ dir: agentDir }, sbxDeps);
    const stateDir = stateDirFor(agentDir, '/home/u');
    expect(plan.sbx?.spec.mounts).toEqual([
      { path: '/work', readonly: false },
      { path: agentDir, readonly: true },
      { path: stateDir, readonly: false },
      { path: '/home/u/.pi/agent', readonly: false }
    ]);
    expect(plan.sbx?.spec.name).toMatch(/^cradle-my-agent-[0-9a-f]{8}-[0-9a-f]{8}$/);
    expect(plan.sbx?.createArgv.slice(0, 3)).toEqual(['/shims/sbx', 'create', 'shell']);
    expect(plan.sbx?.createArgv).toContain(`${agentDir}:ro`);
  });

  it('should compose the bare guest pi argv with no nono wrap and no agent-browser fallback', async () => {
    const plan = await planRun({ dir: agentDir }, sbxDeps);
    const argv = composeArgv(plan.launch);
    expect(argv[0]).toBe('pi');
    expect(argv).not.toContain('nono');
    expect(relFiles(plan)).toEqual([]);
  });

  it('should surface the sbx allowlist-floor disclosure for an allow_domain posture', async () => {
    await addFile('sandbox/sbx.json', JSON.stringify({ network: { allow_domain: ['example.com'] } }));
    const plan = await planRun({ dir: agentDir }, sbxDeps);
    expect(plan.warnings.join('\n')).toContain('cannot subtract');
  });

  it('should rewrite localhost provider baseUrls to the sbx gateway, leaving other hosts and non-object values alone', async () => {
    await addFile(
      'models.json',
      JSON.stringify({
        providers: {
          ollama: { baseUrl: 'http://localhost:11434/v1' },
          spark: { baseUrl: 'http://100.119.191.79:30000/v1' }
        }
      })
    );
    const plan = await planRun({ dir: agentDir }, sbxDeps);
    const providers = plan.files.find(file => file.rel === 'providers.ts')?.content ?? '';
    expect(providers).toContain('http://host.docker.internal:11434/v1');
    expect(providers).toContain('http://100.119.191.79:30000/v1');
    expect(providers).not.toContain('localhost:11434');
  });

  it('should not rewrite provider baseUrls under nono', async () => {
    await rm(join(agentDir, 'sandbox'), { recursive: true });
    await addFile('sandbox/nono.json', '{}');
    await addFile('models.json', JSON.stringify({ providers: { ollama: { baseUrl: 'http://localhost:11434/v1' } } }));
    const plan = await planRun({ dir: agentDir }, deps);
    expect(plan.files.find(file => file.rel === 'providers.ts')?.content ?? '').toContain('http://localhost:11434/v1');
  });
});

describe('materializeRun with the sbx backend', () => {
  const sbxDeps = { ...deps, which: createWhichStub({ pi: '/shims/pi', sbx: '/shims/sbx' }) };

  beforeEach(async () => {
    await rm(join(agentDir, 'sandbox'), { recursive: true });
    await addFile('sandbox/sbx.json', JSON.stringify({ network: { allow_domain: ['example.com'] } }));
  });

  const runRecorder = (results: { exitCode: number; stderr: string }[] = []) => {
    const calls: (readonly string[])[] = [];
    const run = (argv: readonly string[]) => {
      calls.push(argv);
      return Promise.resolve(results.shift() ?? { exitCode: 0, stderr: '' });
    };
    return { calls, run };
  };

  it('should run create, policy, and pinned provision in order, then wrap the argv in sbx exec', async () => {
    const plan = await planRun({ dir: agentDir }, sbxDeps);
    const { calls, run } = runRecorder();
    const result = await materializeRun(plan, { run, readPiVersion: () => Promise.resolve('9.9.9') });
    expect(calls[0]).toEqual([...(plan.sbx?.createArgv ?? [])]);
    expect(calls[1]).toEqual([...(plan.sbx?.policyArgvs[0] ?? [])]);
    expect(calls[2]?.join(' ')).toContain('@9.9.9');
    expect(result.argv.slice(0, 3)).toEqual(['/shims/sbx', 'exec', '-i']);
    expect(result.argv).toContain('HOME=/home/u');
    expect(result.argv).toContain('pi');
  });

  it('should treat an already-exists create failure as attach', async () => {
    const plan = await planRun({ dir: agentDir }, sbxDeps);
    const { run } = runRecorder([{ exitCode: 1, stderr: "sandbox 'x' already exists" }]);
    await expect(materializeRun(plan, { run })).resolves.toBeDefined();
  });

  it('should throw on any other create failure, naming the sandbox', async () => {
    const plan = await planRun({ dir: agentDir }, sbxDeps);
    const { run } = runRecorder([{ exitCode: 1, stderr: 'daemon not running' }]);
    await expect(materializeRun(plan, { run })).rejects.toThrow('daemon not running');
  });

  it('should throw when a policy step fails', async () => {
    const plan = await planRun({ dir: agentDir }, sbxDeps);
    const { run } = runRecorder([
      { exitCode: 0, stderr: '' },
      { exitCode: 1, stderr: 'policy rejected' }
    ]);
    await expect(materializeRun(plan, { run })).rejects.toThrow('policy rejected');
  });

  it('should keep provisioning unpinned when no version reader is provided', async () => {
    const plan = await planRun({ dir: agentDir }, sbxDeps);
    const { calls, run } = runRecorder();
    await materializeRun(plan, { run });
    expect(calls[2]).toEqual([...(plan.sbx?.provisionArgv ?? [])]);
  });

  it('should keep provisioning unpinned when the version reader returns null', async () => {
    const plan = await planRun({ dir: agentDir }, sbxDeps);
    const { calls, run } = runRecorder();
    await materializeRun(plan, { run, readPiVersion: () => Promise.resolve(null) });
    expect(calls[2]).toEqual([...(plan.sbx?.provisionArgv ?? [])]);
  });

  it('should throw when the sbx plan has no command runner', async () => {
    const plan = await planRun({ dir: agentDir }, sbxDeps);
    await expect(materializeRun(plan, {})).rejects.toThrow('command runner');
  });
});
