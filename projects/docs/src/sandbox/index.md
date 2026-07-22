---
{
  title: 'Sandbox',
  description: 'How the sandbox backend is chosen — nono (host OS policy) or sbx (Docker Sandboxes microVM) — and how to configure each.',
  layout: 'index.11ty.js'
}
---

# Sandbox

An agent runs sandboxed when its folder declares `sandbox/nono.json`, `sandbox/sbx.json`, or both — two independent backend opt-ins. Without either file, cradle warns and runs bare `pi`.

## Choosing a backend

[nono](https://github.com/always-further/nono) wraps `pi` in the host's own OS sandbox (Seatbelt on macOS). `pi` runs as your own user against your own filesystem, contained by policy — high host fidelity: your toolchain, your paths, and your loopback all work as-is. The Seatbelt escape hatch below exists because that policy engine has edge cases some tools need widened.

[Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) (`sbx`) runs `pi` inside a microVM instead — a hard boundary, not a policy wrapper. The guest is a disposable Linux VM, so mac-only host integrations like `say` and agent-browser's Unix-socket daemon connection are simply inert inside it: `pi` warns and continues rather than failing the turn.

Backend precedence: `--no-sandbox` (off, unconditionally) > `--sandbox-backend <nono|sbx>` (forces that backend on) > bare `--sandbox` (forces on, using the folder's declared backend, defaulting to nono) > the folder's own posture (`sandbox/nono.json` and `sandbox/sbx.json` are independent sibling opt-ins — a folder enabling both gets nono, with a warning naming `--sandbox-backend sbx` as the override) > restrictive network flags (`--offline`/`--allow-host`, which force nono on when neither file is configured) > unsandboxed default, with a warning.

## sandbox/nono.json

Declaring `sandbox/nono.json` runs the agent inside the [nono](https://github.com/always-further/nono) filesystem sandbox: read-write on your current working directory, read-only on the agent folder. The file widens or tightens the sandbox posture declaratively:

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

## sandbox/sbx.json

The second backend: an agent runs inside [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) (`sbx`) — a disposable microVM, not an OS-policy wrapper — when it declares `sandbox/sbx.json`. It's a sibling opt-in to `sandbox/nono.json`, not a replacement: ship one, the other, or both — see Choosing a backend above for the tie-break.

The schema is a restricted subset of nono's: `sandbox: false` opts out identically; `filesystem` supports `read`/`write`/`allow` only; `network` supports `block`/`allow_domain` only.

```json
{
  "network": { "allow_domain": ["api.example.com", "localhost"] },
  "filesystem": {
    "read": ["~/data"],
    "write": [],
    "allow": ["~/scratch"]
  }
}
```

Keys `sandbox/nono.json` accepts that the VM boundary has no equivalent for — `unix_socket_dir_bind`, `network_profile`, `open_port`, `listen_port`, `unsafe_macos_seatbelt_rules` — are warned and dropped with a dedicated "nono-only" message rather than folded into the generic unsupported-key warning, so copying a working `nono.json` shows immediately which grants didn't survive the port. Everything else reuses nono's own field readers, so a malformed value fails the same way in both files.

### Run model

The guest mount list is fixed at sandbox-creation time, at verbatim host paths:

| Mount                                         | Access |
| --------------------------------------------- | ------ |
| your cwd                                      | rw     |
| the agent folder                              | ro     |
| the per-agent state dir                       | rw     |
| `~/.pi/agent`                                 | rw     |
| linked git dir (worktree/submodule checkouts) | rw     |
| `sandbox/sbx.json` `read` grants              | ro     |
| `sandbox/sbx.json` `write`/`allow` grants     | rw     |

Mounting `~/.pi/agent` matters because the final exec step overrides `HOME` inside the guest to point at it — a host `pi login` carries over unchanged, and any OAuth refresh the guest performs writes back to the same host files, so tokens never drift between the two environments.

The sandbox itself is named `cradle-<agentId>-<hash8>`, where the hash keys the mount set (a sha256 over the sorted, order-insensitive mount list) — a changed grant gets a fresh sandbox instead of attaching to stale mounts. Stale sandboxes aren't reclaimed automatically; clean them up with `sbx rm`.

Materializing a run executes a fixed setup sequence before spawning `pi`:

1. `sbx create shell <mounts...> --name <name> -q` — an "already exists" error is treated as attach, not failure.
2. each per-sandbox `sbx policy` rule (idempotent — see Network semantics below, safe to re-run every launch).
3. provision: install `@earendil-works/pi-coding-agent` in-guest, pinned to the host's own `pi --version`, reinstalling only on a mismatch.
4. `sbx exec -i [-t] -e HOME=<home> -w <cwd> <name> pi <argv...>` — `-t` rides only when stdout is a TTY.

### Network semantics

Differ from nono's, deliberately:

- `network.block: true` becomes a single per-sandbox `sbx policy deny network --sandbox <name> '**'` (verified: this beats the sandbox's inherited global policy).
- `allow_domain` becomes a single per-sandbox allow call: each domain expands to `d,*.d` — sbx matches an exact host and its subdomains as disjoint resources, so both are needed for one logical allow. Bare IPv4 entries pass through unchanged. `localhost`/`127.0.0.1` are dropped and replaced by `host.docker.internal` — guest loopback is the microVM itself, never the host, and `host.docker.internal` is the gateway sbx routes through its policy proxy back to the host's own loopback. The generated providers extension applies the same rewrite to `models.json` `baseUrl`s under sbx only.

**A per-sandbox `allow` rule only ADDS to your machine's global `sbx` policy — it cannot subtract from it.** nono's `allow_domain` is a true allowlist because nono owns the whole proxy; sbx's is layered on top of Docker's own policy system, so strict allowlist semantics need a one-time `sbx policy init deny-all` run once per machine. cradle warns about this gap on every run that emits an allow rule.

One-time machine setup, before the first sandboxed sbx run:

```sh
sbx login
sbx policy init deny-all   # or allow-all / balanced — see sbx's own docs
```

`--dry-run` on an sbx-backend run also prints the `sbx create`/`sbx policy`/provision setup commands, in the order materialize runs them, before the final `sbx exec` argv wrapping the composed `pi` command — the printed provision argv is unpinned (the host `pi` version pin only resolves at materialize time). A silent, non-`--verbose` sbx run prints `🔒 Sandbox Active (sbx)` in place of nono's `🔒 Sandbox Active`.

## Opting out

An agent that still can't run sandboxed can declare the opt-out in either file — `sandbox/nono.json` or `sandbox/sbx.json`:

```json
{
  "sandbox": false
}
```

cradle then runs `pi` bare and warns loudly on every run, naming whichever file disabled it. Precedence: explicit `--sandbox`/`--sandbox-backend`/`--no-sandbox` CLI flags > the folder's own posture (both files enabled → nono wins, with a warning naming `--sandbox-backend sbx` as the override) > restrictive network flags (`--offline`, `--allow-host`, which force nono on) > unsandboxed default. An explicit `--sandbox`/`--sandbox-backend` flag always forces isolation back on.
