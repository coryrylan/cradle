---
{
  title: 'Sandbox',
  description: 'Configure optional nono sandboxing, filesystem grants, and network policy.',
  layout: 'index.11ty.js'
}
---

# Sandbox

An agent runs sandboxed when its folder declares `sandbox/nono.json`. Without that file, cradle warns and runs bare `pi` unless a CLI flag enables isolation.

## Sandbox behavior

[nono](https://github.com/nolabs-ai/nono) wraps `pi` in the host's own OS sandbox (Seatbelt on macOS). `pi` runs as your own user against your own filesystem, contained by policy — high host fidelity: your toolchain, your paths, and your loopback all work as-is. The Seatbelt escape hatch below exists because that policy engine has edge cases some tools need widened.



Sandbox precedence: `--no-sandbox` disables isolation; `--sandbox` forces it on; otherwise `sandbox/nono.json` controls it. Restrictive network flags (`--offline`/`--allow-host`) force isolation when the folder has not enabled it. With no sandbox configuration or restrictive flags, cradle runs bare `pi` with an OS-isolation warning. `--sandbox` uses the folder’s grants when present.

## sandbox/nono.json

Declaring `sandbox/nono.json` runs the agent inside the [nono](https://github.com/nolabs-ai/nono) filesystem sandbox: read-write on your current working directory, read-only on the agent folder. The file widens or tightens the sandbox posture declaratively:

```json
{
  "network": { "block": true },
  "filesystem": {
    "read": ["~/data"],
    "write": [],
    "allow": ["~/scratch"]
  }
}
```

### Unix sockets

Use `filesystem.unix_socket` for connect-only access to individual socket files:

```json
{
  "filesystem": {
    "unix_socket": [
      "~/.config/herdr/herdr.sock",
      "~/Library/Application Support/Moshi/moshi-hook.sock"
    ]
  }
}
```

Cradle expands `~` and `$HOME` and merges these paths with any automatically discovered host integration grants, removing duplicates. This grants no bind access or directory writes. `unix_socket_dir_bind` instead grants connect and bind access to direct-child sockets in a dedicated directory.

### Network policy

Outbound network is **open by default within a sandboxed run**. A `network` block tightens it — the keys mirror nono's canonical `network` profile fields, enforced by nono itself (a local CONNECT/credential proxy that Seatbelt forces all egress through on macOS):

```json
{
  "network": {
    "block": false,
    "allow_domain": ["api.example.com", "localhost"],
    "open_port": [11434],
    "listen_port": [8080]
  }
}
```

| Key               | Effect                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `block`           | `true` denies **all** outbound traffic (full offline).                                            |
| `allow_domain`    | Host allowlist. **Presence flips nono to default-deny** — unlisted hosts are refused.             |
| `open_port`       | localhost TCP ports the agent may connect/bind; `0` allows any outbound localhost port on macOS.  |
| `listen_port`     | TCP ports the agent may listen on.                                                                |
| `network_profile` | A named nono network-policy profile (opaque pass-through; requires a host `network-policy.json`). |

An `allow_domain` allowlist blocks localhost too, so an agent that talks to a local model must list `localhost`/`127.0.0.1` **and** open its port.

CLI flags override the folder: `--offline` (full block) and repeatable `--allow-host <host>` (allowlist). Precedence is `--offline` > `--allow-host` > `sandbox/nono.json` > open. A network policy only means something inside the sandbox, so `--offline`/`--allow-host` imply it — either flag forces the sandbox on (same as passing `--sandbox`) unless `--no-sandbox` is passed explicitly, in which case cradle warns "network policy has no effect without the sandbox — pi runs with no network isolation (--sandbox to enforce it)" and nothing is enforced. cradle doesn't echo the resolved posture itself: run with `--verbose` to drop nono's `--silent` flag and see its own capabilities banner (grants + network mode). nono **fails closed** — a malformed `network` key, or a platform that can't enforce proxy filtering, makes the run refuse to start rather than silently ship an unenforced allowlist.

### macOS Seatbelt escape hatch

Some tools need OS capabilities the conservative base profile denies. `sandbox/nono.json` can append raw macOS Seatbelt rules under `unsafe_macos_seatbelt_rules` — s-expressions merged verbatim after the base profile's rules. nono validates the syntax at load. Each one widens the OS sandbox, so audit them where they live — the folder's `sandbox/nono.json` or the generated per-agent profile — rather than in run output: nono's capabilities banner (shown with `--verbose`) never lists seatbelt rules. Ignored on Linux.

**Browser automation is the motivating case.** [agent-browser](https://agent-browser.dev/) with Chrome for Testing runs sandboxed under nono with a directory grant, a direct-child Unix socket grant, exactly two macOS rules, and Chrome's own `--no-sandbox` flag:

```json
{
  "filesystem": {
    "allow": ["~/.agent-browser"],
    "unix_socket_dir_bind": ["~/.agent-browser"]
  },
  "network": {
    "open_port": [0]
  },
  "unsafe_macos_seatbelt_rules": ["(allow mach-register)", "(allow iokit-open)"]
}
```

| Entry                                   | Why it's needed                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `allow ~/.agent-browser`                | agent-browser's state dir — downloaded Chrome, config, and daemon socket files.                                 |
| `unix_socket_dir_bind ~/.agent-browser` | Lets the CLI and daemon connect to and bind direct-child Unix sockets; without it, `connect()` returns `EPERM`. |
| `open_port 0`                           | Lets the daemon connect to Chrome's random localhost DevTools port on macOS; otherwise CDP returns `EPERM`.     |
| `(allow mach-register)`                 | Chrome's Crashpad handler registers a Mach service; the base profile denies it, so the browser process aborts.  |
| `(allow iokit-open)`                    | Chrome opens IOKit user clients during startup even headless; without it the browser process crashes on launch. |

`unix_socket_dir_bind` is non-recursive. Point it only at a dedicated socket directory, never a broad parent such as `~` or `/tmp`. Port `0` is nono's macOS-only outbound localhost wildcard; Linux requires explicit ports. The two macOS rules are IPC/IOKit capabilities only — filesystem and network boundaries stay intact. Chrome's **own** nested sandbox can't initialize inside nono's seatbelt (macOS forbids nesting), so its child processes need `--no-sandbox` too, delivered through an agent extension so it travels with the folder.

### Per-agent generated profiles

cradle doesn't keep a shared global nono profile. On each run it generates a per-agent profile at `~/.cradle/agents/<id>/nono-profile.json` — a conservative base merged with that run's grants: your cwd, the agent folder, the state dir, the linked git dir when cwd is a linked worktree or submodule checkout (otherwise every sandboxed git command fails with `fatal: not a git repository`, since the real git dir lives outside cwd), and the `sandbox/nono.json` entries above. There's no separate setup step: an agent's entire sandbox posture lives in its own directory. Sandboxed runs also get a private mise cache (`MISE_CACHE_DIR` → `~/.cradle/agents/<id>/mise-cache`) so mise works warning-free without exposing the host's shared cache.

Grant paths tightly. nono refuses to start if a grant overlaps its own state root, so **never** grant `~/` or `/Users` wholesale — widen only the specific paths a tool needs (like `~/.agent-browser` above).

## Opting out

An agent can declare an opt-out in `sandbox/nono.json`:

```json
{
  "sandbox": false
}
```

Cradle then runs `pi` bare and warns on every run. `--sandbox` forces isolation back on; `--no-sandbox` disables it. Restrictive network flags force isolation unless `--no-sandbox` is passed.
