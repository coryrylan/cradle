---
{
  title: 'Sandbox',
  description: 'Sandboxing is opt-in by presence — how the nono sandbox posture is chosen, and how to widen or tighten it.',
  layout: 'index.11ty.js'
}
---

# Sandbox

An agent runs inside the [nono](https://github.com/always-further/nono) filesystem sandbox when it contains `sandbox/nono.json`: read-write on your current working directory, read-only on the agent folder. Without that file, cradle warns and runs bare `pi`. The file widens or tightens the sandbox posture declaratively:

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

## Network policy

Outbound network is **open by default within a sandboxed run**. A `network` block tightens it — the keys mirror nono's canonical `network` profile fields, enforced by nono itself (a local CONNECT/credential proxy that Seatbelt forces all egress through on macOS):

```json
{
  "network": {
    "block": false,
    "allow_domain": ["api.z.ai", "localhost"],
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

## macOS Seatbelt escape hatch

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

## Opting out

An agent that still can't run sandboxed can declare the opt-out in `sandbox/nono.json`:

```json
{
  "sandbox": false
}
```

cradle then runs `pi` bare and warns loudly on every run. Precedence: explicit `--sandbox`/`--no-sandbox` CLI flag > folder `sandbox/nono.json` > restrictive network flags (`--offline`, `--allow-host`, which force the sandbox on) > unsandboxed default — an explicit `--sandbox` flag always forces isolation back on.

## Per-agent generated profiles

cradle doesn't keep a shared global nono profile. On each run it generates a per-agent profile at `~/.cradle/agents/<id>/nono-profile.json` — a conservative base merged with that run's grants: your cwd, the agent folder, the state dir, the linked git dir when cwd is a linked worktree or submodule checkout (otherwise every sandboxed git command fails with `fatal: not a git repository`, since the real git dir lives outside cwd), and the `sandbox/nono.json` entries above. There's no separate setup step: an agent's entire sandbox posture lives in its own directory. Sandboxed runs also get a private mise cache (`MISE_CACHE_DIR` → `~/.cradle/agents/<id>/mise-cache`) so mise works warning-free without exposing the host's shared cache.

Grant paths tightly. nono refuses to start if a grant overlaps its own state root, so **never** grant `~/` or `/Users` wholesale — widen only the specific paths a tool needs (like `~/.agent-browser` above).
