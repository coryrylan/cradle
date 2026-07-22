import { describe, it, expect } from 'bun:test';

import {
  SBX_HOST_GATEWAY,
  composeSbxCreateArgv,
  composeSbxExecArgv,
  composeSbxMounts,
  composeSbxPolicyArgvs,
  composeSbxProvisionArgv,
  isSbxAlreadyExistsError,
  rewriteLocalhostBaseUrl,
  sbxGrantWarnings,
  sbxNetworkWarnings,
  sbxSandboxName,
  type SbxMount,
  type SbxMountContext,
  type SbxSpec
} from './compose.js';

const EMPTY_GRANTS = { read: [], write: [], allow: [], unixSocketDirBind: [] };

function mountContext(overrides: Partial<SbxMountContext> = {}): SbxMountContext {
  return {
    cwd: '/work/project',
    agentDir: '/agents/helper',
    stateDir: '/home/u/.cradle/agents/helper-1a2b3c4d',
    home: '/home/u',
    grants: EMPTY_GRANTS,
    ...overrides
  };
}

function spec(overrides: Partial<SbxSpec> = {}): SbxSpec {
  return {
    sbxBin: 'sbx',
    name: 'cradle-helper-abcd1234',
    cwd: '/work/project',
    home: '/home/u',
    mounts: [
      { path: '/work/project', readonly: false },
      { path: '/agents/helper', readonly: true }
    ],
    piVersion: null,
    tty: false,
    ...overrides
  };
}

describe('SBX_HOST_GATEWAY', () => {
  it('is the docker-internal gateway hostname', () => {
    expect(SBX_HOST_GATEWAY).toBe('host.docker.internal');
  });
});

describe('composeSbxMounts', () => {
  it('should order cwd, agent dir, state dir, and the pi agent store first', () => {
    const mounts = composeSbxMounts(mountContext());
    expect(mounts).toEqual([
      { path: '/work/project', readonly: false },
      { path: '/agents/helper', readonly: true },
      { path: '/home/u/.cradle/agents/helper-1a2b3c4d', readonly: false },
      { path: '/home/u/.pi/agent', readonly: false }
    ]);
  });

  it('should insert the linked git dir (rw) after the pi agent store when present', () => {
    const mounts = composeSbxMounts(mountContext({ linkedGitDir: '/main-repo/.git' }));
    expect(mounts.map(mount => mount.path)).toEqual([
      '/work/project',
      '/agents/helper',
      '/home/u/.cradle/agents/helper-1a2b3c4d',
      '/home/u/.pi/agent',
      '/main-repo/.git'
    ]);
    expect(mounts.find(mount => mount.path === '/main-repo/.git')?.readonly).toBe(false);
  });

  it('should omit the linked git dir mount for a regular repo', () => {
    const mounts = composeSbxMounts(mountContext());
    expect(mounts.some(mount => mount.path === '/main-repo/.git')).toBe(false);
  });

  it('should append grants after the fixed base mounts: read ro, write and allow rw', () => {
    const mounts = composeSbxMounts(
      mountContext({
        grants: { read: ['/etc/certs'], write: ['/scratch'], allow: ['/data'], unixSocketDirBind: [] }
      })
    );
    expect(mounts.slice(-3)).toEqual([
      { path: '/etc/certs', readonly: true },
      { path: '/scratch', readonly: false },
      { path: '/data', readonly: false }
    ]);
  });

  it('should expand ~ and $HOME in grant paths against home', () => {
    const mounts = composeSbxMounts(
      mountContext({
        grants: { read: ['~/data'], write: ['$HOME/out'], allow: [], unixSocketDirBind: [] }
      })
    );
    expect(mounts).toEqual(
      expect.arrayContaining([
        { path: '/home/u/data', readonly: true },
        { path: '/home/u/out', readonly: false }
      ])
    );
  });

  it('should ignore unixSocketDirBind grants (covered by sbxGrantWarnings instead)', () => {
    const mounts = composeSbxMounts(
      mountContext({ grants: { read: [], write: [], allow: [], unixSocketDirBind: ['~/.agent-browser'] } })
    );
    expect(mounts.some(mount => mount.path.includes('.agent-browser'))).toBe(false);
  });

  it('should dedupe a repeated path, keeping first-occurrence order, rw beats ro', () => {
    const mounts = composeSbxMounts(
      mountContext({
        agentDir: '/agents/helper',
        grants: { read: ['/agents/helper'], write: [], allow: ['/agents/helper'], unixSocketDirBind: [] }
      })
    );
    const occurrences = mounts.filter(mount => mount.path === '/agents/helper');
    expect(occurrences).toEqual([{ path: '/agents/helper', readonly: false }]);
    // The dedup keeps the earliest position (agentDir, index 1) rather than re-appending at the tail.
    expect(mounts[1]).toEqual({ path: '/agents/helper', readonly: false });
  });

  it('should keep a path read-only when every occurrence is read-only', () => {
    const mounts = composeSbxMounts(
      mountContext({ grants: { read: ['/agents/helper'], write: [], allow: [], unixSocketDirBind: [] } })
    );
    expect(mounts.filter(mount => mount.path === '/agents/helper')).toEqual([
      { path: '/agents/helper', readonly: true }
    ]);
  });

  it('should handle empty grants with just the fixed base mounts', () => {
    expect(composeSbxMounts(mountContext()).map(mount => mount.path)).toEqual([
      '/work/project',
      '/agents/helper',
      '/home/u/.cradle/agents/helper-1a2b3c4d',
      '/home/u/.pi/agent'
    ]);
  });
});

describe('sbxSandboxName', () => {
  const mounts: SbxMount[] = [
    { path: '/work/project', readonly: false },
    { path: '/agents/helper', readonly: true }
  ];

  it('should produce a cradle-<basename>-<hash8> name', () => {
    expect(sbxSandboxName('helper-1a2b3c4d', mounts)).toMatch(/^cradle-helper-1a2b3c4d-[0-9a-f]{8}$/);
  });

  it('should be stable regardless of mount order', () => {
    const reordered = [...mounts].reverse();
    expect(sbxSandboxName('helper-1a2b3c4d', mounts)).toBe(sbxSandboxName('helper-1a2b3c4d', reordered));
  });

  it('should change when the mount set changes', () => {
    const changed: SbxMount[] = [...mounts, { path: '/extra', readonly: true }];
    expect(sbxSandboxName('helper-1a2b3c4d', mounts)).not.toBe(sbxSandboxName('helper-1a2b3c4d', changed));
  });

  it('should change when a mount access mode changes (fixed-at-creation invariant)', () => {
    const flipped: SbxMount[] = [
      { path: '/work/project', readonly: false },
      { path: '/agents/helper', readonly: false }
    ];
    expect(sbxSandboxName('helper-1a2b3c4d', mounts)).not.toBe(sbxSandboxName('helper-1a2b3c4d', flipped));
  });
});

describe('composeSbxCreateArgv', () => {
  it('should compose create argv with :ro suffixes and cwd first', () => {
    expect(composeSbxCreateArgv(spec())).toEqual([
      'sbx',
      'create',
      'shell',
      '/work/project',
      '/agents/helper:ro',
      '--name',
      'cradle-helper-abcd1234',
      '-q'
    ]);
  });

  it('should use the resolved sbx binary when provided', () => {
    const argv = composeSbxCreateArgv(spec({ sbxBin: '/opt/homebrew/bin/sbx' }));
    expect(argv[0]).toBe('/opt/homebrew/bin/sbx');
  });
});

describe('composeSbxPolicyArgvs', () => {
  it('should return no argvs when the spec has no network posture', () => {
    expect(composeSbxPolicyArgvs(spec())).toEqual([]);
  });

  it('should emit a single deny-all argv under block, ignoring allowDomain (block wins)', () => {
    const argvs = composeSbxPolicyArgvs(spec({ network: { block: true, allowDomain: ['api.example.com'] } }));
    expect(argvs).toEqual([['sbx', 'policy', 'deny', 'network', '--sandbox', 'cradle-helper-abcd1234', '**']]);
  });

  it('should expand each allowed domain to d,*.d', () => {
    const argvs = composeSbxPolicyArgvs(spec({ network: { allowDomain: ['api.example.com', 'example.com'] } }));
    expect(argvs).toEqual([
      [
        'sbx',
        'policy',
        'allow',
        'network',
        '--sandbox',
        'cradle-helper-abcd1234',
        'api.example.com,*.api.example.com,example.com,*.example.com'
      ]
    ]);
  });

  it('should keep raw IPv4 addresses bare (no *. form)', () => {
    const argvs = composeSbxPolicyArgvs(spec({ network: { allowDomain: ['203.0.113.5'] } }));
    expect(argvs).toEqual([
      ['sbx', 'policy', 'allow', 'network', '--sandbox', 'cradle-helper-abcd1234', '203.0.113.5']
    ]);
  });

  it('should replace localhost with host.docker.internal', () => {
    const argvs = composeSbxPolicyArgvs(spec({ network: { allowDomain: ['localhost'] } }));
    expect(argvs).toEqual([
      ['sbx', 'policy', 'allow', 'network', '--sandbox', 'cradle-helper-abcd1234', 'host.docker.internal']
    ]);
  });

  it('should dedupe host.docker.internal when both localhost and 127.0.0.1 are present', () => {
    const argvs = composeSbxPolicyArgvs(spec({ network: { allowDomain: ['localhost', '127.0.0.1', 'api.example.com'] } }));
    expect(argvs).toEqual([
      [
        'sbx',
        'policy',
        'allow',
        'network',
        '--sandbox',
        'cradle-helper-abcd1234',
        'api.example.com,*.api.example.com,host.docker.internal'
      ]
    ]);
  });

  it('should emit nothing for a non-blocking network posture with no allowDomain', () => {
    expect(composeSbxPolicyArgvs(spec({ network: { openPort: [8080] } }))).toEqual([]);
  });
});

describe('sbxNetworkWarnings', () => {
  it('should return no warnings when network is undefined', () => {
    expect(sbxNetworkWarnings(undefined)).toEqual([]);
  });

  it('should return no warnings for an empty network object', () => {
    expect(sbxNetworkWarnings({})).toEqual([]);
  });

  it('should warn when networkProfile is set', () => {
    expect(sbxNetworkWarnings({ networkProfile: 'developer' })).toEqual([
      'network_profile is nono-only — ignored under the sbx backend'
    ]);
  });

  it('should warn when openPort or listenPort is non-empty', () => {
    const message =
      'open_port/listen_port are nono-only — guest-local ports are unrestricted and host services are reachable via host.docker.internal under sbx';
    expect(sbxNetworkWarnings({ openPort: [0] })).toEqual([message]);
    expect(sbxNetworkWarnings({ listenPort: [8080] })).toEqual([message]);
  });

  it('should warn when allowDomain is non-empty and not blocked', () => {
    expect(sbxNetworkWarnings({ allowDomain: ['api.example.com'] })).toEqual([
      'sbx allow rules add to your global sbx policy but cannot subtract from it — run `sbx policy init deny-all` for strict allowlist semantics (nono enforces the allowlist exactly)'
    ]);
  });

  it('should not warn about allowDomain when block is true', () => {
    expect(sbxNetworkWarnings({ block: true, allowDomain: ['api.example.com'] })).toEqual([]);
  });

  it('should collect every applicable warning together', () => {
    const warnings = sbxNetworkWarnings({
      networkProfile: 'developer',
      allowDomain: ['api.example.com'],
      openPort: [0],
      listenPort: [8080]
    });
    expect(warnings).toHaveLength(3);
  });
});

describe('sbxGrantWarnings', () => {
  it('should return no warnings for empty grants', () => {
    expect(sbxGrantWarnings(EMPTY_GRANTS)).toEqual([]);
  });

  it('should warn when unixSocketDirBind is non-empty', () => {
    expect(sbxGrantWarnings({ read: [], write: [], allow: [], unixSocketDirBind: ['~/.agent-browser'] })).toEqual([
      'unix_socket_dir_bind is nono-only — Unix sockets cannot cross the sbx VM boundary; grant ignored'
    ]);
  });
});

describe('composeSbxProvisionArgv', () => {
  it('should install pi only if missing when piVersion is null', () => {
    expect(composeSbxProvisionArgv(spec({ piVersion: null }))).toEqual([
      'sbx',
      'exec',
      'cradle-helper-abcd1234',
      'bash',
      '-lc',
      'command -v pi >/dev/null 2>&1 || npm i -g @earendil-works/pi-coding-agent'
    ]);
  });

  it('should pin and reinstall on a version mismatch when piVersion is set', () => {
    expect(composeSbxProvisionArgv(spec({ piVersion: '1.2.3' }))).toEqual([
      'sbx',
      'exec',
      'cradle-helper-abcd1234',
      'bash',
      '-lc',
      'command -v pi >/dev/null 2>&1 && [ "$(pi --version 2>/dev/null)" = "1.2.3" ] || npm i -g @earendil-works/pi-coding-agent@1.2.3'
    ]);
  });
});

describe('composeSbxExecArgv', () => {
  it('should compose exec argv without -t when tty is false', () => {
    expect(composeSbxExecArgv(spec({ tty: false }), ['pi', '-p', 'hi'])).toEqual([
      'sbx',
      'exec',
      '-i',
      '-e',
      'HOME=/home/u',
      '-w',
      '/work/project',
      'cradle-helper-abcd1234',
      'pi',
      '-p',
      'hi'
    ]);
  });

  it('should include -t when tty is true', () => {
    const argv = composeSbxExecArgv(spec({ tty: true }), ['pi']);
    expect(argv).toEqual([
      'sbx',
      'exec',
      '-i',
      '-t',
      '-e',
      'HOME=/home/u',
      '-w',
      '/work/project',
      'cradle-helper-abcd1234',
      'pi'
    ]);
  });
});

describe('isSbxAlreadyExistsError', () => {
  it('should match "already exists" case-insensitively', () => {
    expect(isSbxAlreadyExistsError('Error: sandbox "foo" already exists')).toBe(true);
    expect(isSbxAlreadyExistsError('SANDBOX ALREADY EXISTS')).toBe(true);
  });

  it('should not match unrelated stderr', () => {
    expect(isSbxAlreadyExistsError('Error: no such sandbox')).toBe(false);
    expect(isSbxAlreadyExistsError('')).toBe(false);
  });
});

describe('rewriteLocalhostBaseUrl', () => {
  it('should rewrite a localhost host to the sbx gateway', () => {
    expect(rewriteLocalhostBaseUrl('http://localhost/v1')).toBe('http://host.docker.internal/v1');
  });

  it('should rewrite a 127.0.0.1 host to the sbx gateway', () => {
    expect(rewriteLocalhostBaseUrl('http://127.0.0.1/v1')).toBe('http://host.docker.internal/v1');
  });

  it('should preserve scheme, port, and path', () => {
    expect(rewriteLocalhostBaseUrl('https://localhost:11434/api/generate')).toBe(
      'https://host.docker.internal:11434/api/generate'
    );
  });

  it('should leave a non-localhost host unchanged', () => {
    expect(rewriteLocalhostBaseUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1');
  });

  it('should leave an unparseable URL unchanged', () => {
    expect(rewriteLocalhostBaseUrl('not a url')).toBe('not a url');
  });
});
