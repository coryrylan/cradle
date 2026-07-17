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
| `open_port`       | localhost TCP ports the agent may connect to or bind (e.g. a local model or dev server).          |
| `listen_port`     | TCP ports the agent may listen on.                                                                |
| `network_profile` | A named nono network-policy profile (opaque pass-through; requires a host `network-policy.json`). |

An `allow_domain` allowlist blocks localhost too, so an agent that talks to a local model must list `localhost`/`127.0.0.1` **and** open its port.

CLI flags override the folder: `--offline` (full block) and repeatable `--allow-host <host>` (allowlist). Precedence is `--offline` > `--allow-host` > `sandbox/nono.json` > open. A network policy only means something inside the sandbox, so `--offline`/`--allow-host` imply it — either flag forces the sandbox on (same as passing `--sandbox`) unless `--no-sandbox` is passed explicitly, in which case cradle warns "network policy has no effect without the sandbox — pi runs with no network isolation (--sandbox to enforce it)" and nothing is enforced. cradle doesn't echo the resolved posture itself: run with `--verbose` to drop nono's `--silent` flag and see its own capabilities banner (grants + network mode). nono **fails closed** — a malformed `network` key, or a platform that can't enforce proxy filtering, makes the run refuse to start rather than silently ship an unenforced allowlist.

## macOS Seatbelt escape hatch

Some tools need OS capabilities the conservative base profile denies. `sandbox/nono.json` can append raw macOS Seatbelt rules under `unsafe_macos_seatbelt_rules` — s-expressions merged verbatim after the base profile's rules. nono validates the syntax at load. Each one widens the OS sandbox, so audit them where they live — the folder's `sandbox/nono.json` or the generated per-agent profile — rather than in run output: nono's capabilities banner (shown with `--verbose`) never lists seatbelt rules. Ignored on Linux.

**Browser automation is the motivating case.** [agent-browser](https://agent-browser.dev/) with Chrome for Testing runs sandboxed under nono with exactly two rules, plus Chrome's own `--no-sandbox` flag:

```json
{
  "filesystem": {
    "allow": ["~/.agent-browser"]
  },
  "unsafe_macos_seatbelt_rules": ["(allow mach-register)", "(allow iokit-open)"]
}
```

| Entry                    | Why it's needed                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `allow ~/.agent-browser` | agent-browser's own state dir — daemon socket, downloaded Chrome, config.                                       |
| `(allow mach-register)`  | Chrome's Crashpad handler registers a Mach service; the base profile denies it, so the browser process aborts.  |
| `(allow iokit-open)`     | Chrome opens IOKit user clients during startup even headless; without it the browser process crashes on launch. |

The two rules are IPC/IOKit capabilities only — filesystem and network boundaries stay intact. Chrome's **own** nested sandbox can't initialize inside nono's seatbelt (macOS forbids nesting), so its child processes need `--no-sandbox` too, delivered through an agent extension so it travels with the folder.

## Opting out

An agent that still can't run sandboxed can declare the opt-out in `sandbox/nono.json`:

```json
{
  "sandbox": false
}
```

cradle then runs `pi` bare and warns loudly on every run. Precedence: explicit `--sandbox`/`--no-sandbox` CLI flag > folder `sandbox/nono.json` > restrictive network flags (`--offline`, `--allow-host`, which force the sandbox on) > unsandboxed default — an explicit `--sandbox` flag always forces isolation back on.

## Per-agent generated profiles

cradle doesn't keep a shared global nono profile. On each run it generates a per-agent profile at `~/.cradle/agents/<id>/nono-profile.json` — a conservative base merged with that run's grants: your cwd, the agent folder, the state dir, and the `sandbox/nono.json` entries above. There's no separate setup step: an agent's entire sandbox posture lives in its own directory.

Grant paths tightly. nono refuses to start if a grant overlaps its own state root, so **never** grant `~/` or `/Users` wholesale — widen only the specific paths a tool needs (like `~/.agent-browser` above).
