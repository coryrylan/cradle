import { describe, it, expect } from 'bun:test';
import {
  AGENT_PROFILE_FILE,
  buildProfileJson,
  expandHome,
  findDegenerateSandboxCwd,
  type ProfileSpec
} from './profiles.js';
import cradlePiProfile from './cradle-pi.json' with { type: 'json' };

// The state tree holds mise's trust db (trusted-configs/); without it sandboxed mise
// treats every config as untrusted and refuses to run.
const MISE_READS = ['$HOME/.local/share/mise', '$HOME/.config/mise', '$HOME/.local/state/mise'];

function spec(overrides: Partial<ProfileSpec> = {}): ProfileSpec {
  return {
    home: '/home/u',
    cwd: '/work/project',
    agentDir: '/agents/helper',
    stateDir: '/home/u/.cradle/agents/helper-1a2b3c4d',
    grants: { read: [], write: [], allow: [], unixSocketDirBind: [] },
    rules: [],
    ...overrides
  };
}

const build = (overrides: Partial<ProfileSpec> = {}) => JSON.parse(buildProfileJson(spec(overrides)));

describe('expandHome', () => {
  it('should expand a leading ~ or $HOME against home', () => {
    expect(expandHome('~', '/home/u')).toBe('/home/u');
    expect(expandHome('~/x', '/home/u')).toBe('/home/u/x');
    expect(expandHome('$HOME', '/home/u')).toBe('/home/u');
    expect(expandHome('$HOME/x', '/home/u')).toBe('/home/u/x');
  });

  it('should leave absolute, relative, and mid-string ~ paths unchanged', () => {
    expect(expandHome('/abs', '/home/u')).toBe('/abs');
    expect(expandHome('rel', '/home/u')).toBe('rel');
    expect(expandHome('a~b', '/home/u')).toBe('a~b');
  });
});

describe('AGENT_PROFILE_FILE', () => {
  it('is the state-dir filename nono run --profile points at', () => {
    expect(AGENT_PROFILE_FILE).toBe('nono-profile.json');
  });
});

describe('buildProfileJson', () => {
  it('carries the embedded base through: extends default, node_runtime, mise reads, pi allow', () => {
    const profile = build();
    expect(profile.extends).toBe('default');
    expect(profile.groups.include).toEqual(['node_runtime', 'git_config', 'unlink_protection']);
    expect(profile.filesystem.read).toEqual(expect.arrayContaining(MISE_READS));
    // Without ~/.agents a sandboxed pi silently loses the user's global skills.
    expect(profile.filesystem.read).toContain('$HOME/.agents');
    expect(profile.filesystem.allow).toContain('$HOME/.pi/agent');
  });

  it('grants the coding-agent essentials nono default omits: git config, gh auth', () => {
    const profile = build();
    // nono default extends without git_config, so a sandboxed `git` loses the
    // user's identity (~/.gitconfig). The built-in group grants it file-level.
    expect(profile.groups.include).toContain('git_config');
    // gh CLI reads ~/.config/gh/{config,hosts}.yml; without it `gh auth status`
    // dies with "operation not permitted" before any network call.
    expect(profile.filesystem.read).toContain('$HOME/.config/gh');
  });

  it('adds unlink_protection: blocks deletion outside user-writable grants', () => {
    // Defense-in-depth the default base lacks; deletions in cwd/state (allow)
    // still work, deletions in read-only/system paths are blocked.
    expect(build().groups.include).toContain('unlink_protection');
  });

  it('preserves the macOS say grants (synthesizer reads + scoped pref rule)', () => {
    const profile = build();
    expect(profile.filesystem.read).toContain(
      '/System/Library/AssetsV2/com_apple_MobileAsset_TTSAXResourceModelAssets'
    );
    const rule = profile.unsafe_macos_seatbelt_rules?.[0] ?? '';
    expect(rule).toContain('com.apple.speech.voice.prefs');
    expect(rule).not.toBe('(allow user-preference-read)');
  });

  it('folds this run’s dynamic grants in: cwd + state dir read-write, agent dir read-only', () => {
    const profile = build();
    expect(profile.filesystem.allow).toContain('/work/project'); // cwd
    expect(profile.filesystem.allow).toContain('/home/u/.cradle/agents/helper-1a2b3c4d'); // state dir
    expect(profile.filesystem.read).toContain('/agents/helper'); // agent folder (read-only)
  });

  it('grants the linked git dir when the run resolved one (linked worktree/submodule cwd)', () => {
    const profile = build({ linkedGitDir: '/main-repo/.git' });
    expect(profile.filesystem.allow).toContain('/main-repo/.git');
  });

  it('omits any linked-git-dir grant for a regular repo (no linkedGitDir on the spec)', () => {
    const profile = build();
    expect(profile.filesystem.allow).toEqual([
      '$HOME/.pi/agent',
      '/work/project',
      '/home/u/.cradle/agents/helper-1a2b3c4d'
    ]);
  });

  it('folds the agent’s sandbox/nono.json grants in, expanding ~ and $HOME', () => {
    const profile = build({
      grants: {
        read: ['~/data', '/etc/certs'],
        write: ['$HOME/out'],
        allow: ['~/scratch'],
        unixSocketDirBind: ['~/.agent-browser']
      }
    });
    expect(profile.filesystem.read).toEqual(expect.arrayContaining(['/home/u/data', '/etc/certs']));
    expect(profile.filesystem.write).toEqual(['/home/u/out']);
    expect(profile.filesystem.allow).toContain('/home/u/scratch');
    expect(profile.filesystem.unix_socket_dir_bind).toEqual(['/home/u/.agent-browser']);
  });

  it('omits Unix socket grants when the agent supplies none', () => {
    expect(build().filesystem.unix_socket_dir_bind).toBeUndefined();
  });

  it('appends the agent’s seatbelt rules after the base rules (Seatbelt is last-match-wins)', () => {
    const profile = build({ rules: ['(allow mach-register)', '(allow iokit-open)'] });
    const rules: string[] = profile.unsafe_macos_seatbelt_rules;
    // The base say-voice pref rule stays first; agent rules follow so a later
    // agent allow can widen the base, never the reverse.
    expect(rules[0]).toContain('com.apple.speech.voice.prefs');
    expect(rules.slice(-2)).toEqual(['(allow mach-register)', '(allow iokit-open)']);
  });

  it('leaves the base rules untouched when the agent supplies none', () => {
    expect(build().unsafe_macos_seatbelt_rules).toEqual(cradlePiProfile.unsafe_macos_seatbelt_rules);
  });

  it('omits the network block when the agent sets no network policy (nono default: open)', () => {
    expect(build().network).toBeUndefined();
  });

  it('emits a full block into the profile network block', () => {
    expect(build({ network: { block: true } }).network).toEqual({ block: true });
  });

  it('maps the agent network fields to nono canonical snake_case keys', () => {
    const profile = build({
      network: {
        block: false,
        networkProfile: 'developer',
        allowDomain: ['api.z.ai', 'localhost'],
        openPort: [0, 11434],
        listenPort: [8080]
      }
    });
    expect(profile.network).toEqual({
      block: false,
      network_profile: 'developer',
      allow_domain: ['api.z.ai', 'localhost'],
      open_port: [0, 11434],
      listen_port: [8080]
    });
  });

  it('derives a distinct cradle- prefixed meta.name from the state dir so agents never collide', () => {
    expect(build().meta.name).toBe('cradle-helper-1a2b3c4d');
    expect(build({ stateDir: '/s/other-99887766' }).meta.name).toBe('cradle-other-99887766');
    // The base file keeps its own name; the generated profile overrides it per agent.
    expect(cradlePiProfile.meta.name).toBe('cradle-pi');
  });
});

describe('findDegenerateSandboxCwd', () => {
  it('flags a cwd equal to the home dir', () => {
    expect(findDegenerateSandboxCwd('/home/u', '/home/u')).toBe('/home/u');
  });

  it('flags an ancestor of the home dir (e.g. /Users or /)', () => {
    expect(findDegenerateSandboxCwd('/Users', '/Users/coryrylan')).toBe('/Users');
    expect(findDegenerateSandboxCwd('/', '/Users/coryrylan')).toBe('/');
  });

  it('flags a directory that itself contains nono’s protected state root', () => {
    expect(findDegenerateSandboxCwd('/home/u/.local', '/home/u')).toBe('/home/u/.local');
    expect(findDegenerateSandboxCwd('/home/u/.local/state', '/home/u')).toBe('/home/u/.local/state');
  });

  it('flags a cwd nested inside the protected state root itself', () => {
    expect(findDegenerateSandboxCwd('/home/u/.local/state/nono/sub', '/home/u')).toBe('/home/u/.local/state/nono/sub');
  });

  it('leaves a normal project cwd alone', () => {
    expect(findDegenerateSandboxCwd('/work/project', '/home/u')).toBeUndefined();
  });

  it('leaves the protected root’s sibling dirs under home alone', () => {
    // ~/.cradle sits alongside ~/.local, not above or inside it — not a degenerate grant.
    expect(findDegenerateSandboxCwd('/home/u/.cradle', '/home/u')).toBeUndefined();
  });
});
