# cradle

![CI Build](https://github.com/coryrylan/cradle/actions/workflows/pull-request.yml/badge.svg)

A runtime for portable agents defined as folders. `cradle start <dir>` reads an agent folder — a `SYSTEM.md` or `APPEND_SYSTEM.md` (at least one) plus optional pi-native config, skills, extensions, and sandbox posture — and launches the [pi](https://github.com/earendil-works/pi-mono) coding agent configured from it. An agent declaring `sandbox/nono.json` runs inside the [nono](https://github.com/always-further/nono) filesystem sandbox. See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the folder format and [`examples/hello`](../../examples/hello) for a minimal agent. Built with Bun and TypeScript; install the standalone binary via `install.sh` (primary) or the npm package [`@coryrylan/cradle`](https://www.npmjs.com/package/@coryrylan/cradle) (alternative).

## Dependencies

`cradle` drives external tools rather than bundling them. Run `cradle doctor` to check what's on your PATH.

| Tool                                              | Status          | Why                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`pi`](https://github.com/earendil-works/pi-mono) | **Required**    | The coding agent cradle launches. Every `cradle start` spawns it.                                                                                                                                                                                    |
| [`nono`](https://github.com/always-further/nono)  | **Recommended** | The filesystem sandbox pi runs inside for a sandboxed run — a folder declaring `sandbox/nono.json`, or `--sandbox`/`--offline`/`--allow-host`; required for that run, not needed otherwise.                                                          |
| [`mise`](https://mise.jdx.dev)                    | **Recommended** | The supported way to install and manage `pi` and `nono`. cradle doesn't invoke mise directly, but it falls back to mise's shims when resolving the tools, and the generated sandbox profile grants mise's trees so a sandboxed pi finds its runtime. |

## Installation

Install the standalone binary to `~/.local/bin/cradle` (macOS and Linux; no Bun required to run it):

```bash
curl -fsSL https://coryrylan.github.io/cradle/install.sh | bash
```

Or install the npm package — the installed command is still `cradle`, and [Bun](https://bun.sh) must be on your `PATH` to run it:

```bash
npm install -g @coryrylan/cradle
```

The install script and binaries are statically deployed with the [docs site](https://coryrylan.github.io/cradle/); from a clone, `bun run install:local` in `projects/cli/` builds and installs the same binary locally.

## Development

Clone the repo and install dependencies:

```bash
bun install
```

Run the CLI directly:

```bash
bun start
```

## Commands

| Command                   | Description                                                     |
| ------------------------- | --------------------------------------------------------------- |
| `bun start`               | Run the CLI via Bun                                             |
| `bun run build`           | Build ESM bundle, type declarations, and platform binaries      |
| `bun run test`            | Run tests (no coverage)                                         |
| `bun run test:coverage`   | Run tests with coverage; enforces thresholds from `bunfig.toml` |
| `bun run lint`            | Lint this package with ESLint (typescript-eslint strict)        |
| `bun run ci`              | Run lint + build + test:coverage (used in CI)                   |
| `bun run ci:nocache`      | Clean `dist/` then run `ci` (useful for cache debugging)        |
| `bun run install:local`   | Build and install binary to `~/.local/bin`                      |
| `bun run uninstall:local` | Remove locally installed binary                                 |

> Formatting (Prettier) and Knip (unused files / deps / exports) run at the monorepo root, not per-package. From the repo root: `bun run format` / `bun run format:fix` and `bun run lint:knip`.

## CLI Usage

```bash
cradle --version
cradle doctor                         # check pi (required), nono/mise (recommended) on PATH, with versions
cradle start ./my-agent               # run an agent folder with pi; sandboxed when sandbox/nono.json exists
cradle start my-agent                 # run a name from ~/.cradle/settings.json instead of a path
cradle start . --offline              # block all outbound network (exfil protection)
cradle start . --allow-host api.z.ai  # restrict network to these hosts (repeatable)
cradle start . --no-sandbox           # run pi directly (debug)
cradle start . --dry-run -- --resume  # print the write plan + command; forward `--resume` to pi
```

The agent runs in _your_ working directory; the agent folder is a parameter (default `.`). Everything after `--` is forwarded verbatim to pi. `--dry-run` prints the generated-extension write plan and the composed command without spawning (and without requiring the bins to be installed). Per-agent state (generated extensions + session history) lives under `~/.cradle/agents/<name>-<hash>/`.

### Global agent aliases (`~/.cradle/settings.json`)

The `dir` positional accepts a bare name instead of a path — `cradle start my-agent` resolves against a global name → folder map, so agent folders you keep far from any project don't need a full path from every cwd:

```json
{
  "agents": {
    "my-agent": { "path": "~/dev/agents/my-agent/" }
  }
}
```

A bare name (no `/`, not `.`/`~`-led) checks the alias table first, falling back to the cwd-relative path (`./my-agent`) when no alias is defined — anything already path-shaped (`./x`, `../x`, `/abs/x`, `~/x`, `.`) is never looked up as an alias. See [ARCHITECTURE.md](../../ARCHITECTURE.md#global-agent-aliases) for the full resolution rules.

Each sandboxed run generates its own nono profile at `~/.cradle/agents/<id>/nono-profile.json` — the built-in base merged with that agent's `sandbox/nono.json` grants — and points `nono run --profile` at it. There's no shared global profile and no separate setup step: an agent's whole sandbox posture lives in its own directory. To widen it (e.g. granting a tool's data dir), add a `sandbox/` folder to the agent with a `nono.json`:

```json
{
  "filesystem": {
    "allow": ["~/.some-tool"]
  }
}
```

### Network policy (`network`)

Outbound network is **open by default within a sandboxed run**. A `network` block in `sandbox/nono.json` tightens it — the keys mirror nono's canonical [`network`](https://nono.sh/docs) profile fields, folded into the generated profile and enforced by nono (a local CONNECT/credential proxy that Seatbelt forces all egress through). Verified enforced on macOS Seatbelt:

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

| Key               | Effect                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `block`           | `true` denies **all** outbound (full offline).                                                   |
| `allow_domain`    | Host allowlist. **Presence flips nono to default-deny** — unlisted hosts are refused (403).      |
| `open_port`       | localhost TCP ports the agent may connect/bind; `0` allows any outbound localhost port on macOS. |
| `listen_port`     | TCP ports the agent may listen on.                                                               |
| `network_profile` | Named nono network-policy profile (opaque pass-through; requires a host `network-policy.json`).  |

An `allow_domain` allowlist blocks localhost too, so a local-model agent must list `localhost`/`127.0.0.1` **and** open its port (see [`examples/hello`](../../examples/hello), locked to Ollama on `localhost:11434`). CLI flags override the folder: `--offline` (full block) and repeatable `--allow-host <host>` (allowlist). Precedence: `--offline` > `--allow-host` > `sandbox/nono.json` > open. Requesting a network policy only means something inside the sandbox, so `--offline`/`--allow-host` force the sandbox on (same as `--sandbox`) unless `--no-sandbox` is passed explicitly, in which case cradle warns `network policy has no effect without the sandbox — pi runs with no network isolation (--sandbox to enforce it)` and nothing is enforced. cradle doesn't echo the resolved posture itself — run with `--verbose` to drop nono's `--silent` flag and see its own capabilities banner (grants + network mode), or read the generated per-agent profile (`nono-profile.json` in the agent's state dir). nono **fails closed** — a malformed `network` key or a platform that can't enforce proxy filtering makes the run refuse to start rather than silently ship an unenforced allowlist.

### macOS Seatbelt escape hatch (`unsafe_macos_seatbelt_rules`)

Some tools need OS capabilities the conservative base profile denies. `sandbox/nono.json` can append raw macOS Seatbelt rules — s-expressions merged verbatim after the base's rules (nono validates the syntax at load). Each one widens the OS sandbox, so audit them where they live: the folder's `sandbox/nono.json` or the generated per-agent profile (`nono-profile.json` in the agent's state dir) — nono's own capabilities banner (shown with `--verbose`) never lists seatbelt rules. Ignored on Linux.

**Browser automation is the motivating case.** [agent-browser](https://agent-browser.dev/) + Chrome for Testing runs sandboxed under nono with a directory grant, a direct-child Unix socket grant, exactly two macOS rules, and Chrome's own `--no-sandbox` flag:

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

| Entry                                   | Why it's needed                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow ~/.agent-browser`                | agent-browser's state dir — downloaded Chrome, config, and daemon socket files.                                                                               |
| `unix_socket_dir_bind ~/.agent-browser` | Lets the CLI and daemon connect to and bind direct-child Unix sockets; without it, `connect()` returns `EPERM`.                                               |
| `open_port 0`                           | Lets the daemon connect to Chrome's random localhost DevTools port on macOS; without it, the CDP WebSocket returns `EPERM`.                                   |
| `(allow mach-register)`                 | Chrome's Crashpad handler registers a Mach service (`bootstrap_check_in org.chromium.crashpad.*`); the base profile denies it, so the browser process aborts. |
| `(allow iokit-open)`                    | Chrome opens IOKit user clients during startup even headless; without it the browser process crashes before serving CDP.                                      |

`unix_socket_dir_bind` is non-recursive. Point it only at a dedicated socket directory, never a broad parent such as `~` or `/tmp`. Port `0` is nono's macOS-only outbound localhost wildcard; Linux requires explicit ports. The two macOS rules are IPC/IOKit capabilities only — the filesystem and network boundaries stay intact, so the sandbox still denies an ungranted path (verified: a granted read succeeds, `~/some-secret` returns `Operation not permitted`). No grant for Chrome's own `~/Library/…/Chrome for Testing` dir is needed — its Crashpad-database `stat` failure under the sandbox is non-fatal noise.

Chrome's **own** nested sandbox can't initialize inside nono's seatbelt (macOS forbids nesting), so its child processes need `--no-sandbox`. On every sandboxed run, cradle generates and loads `agent-browser-nono-fallback.ts` before package and agent extensions. On macOS it appends `--no-sandbox` to `AGENT_BROWSER_ARGS`; on every platform it maps nono's dynamically injected `HTTPS_PROXY`/`HTTP_PROXY` to `AGENT_BROWSER_PROXY`. Explicit agent-browser proxy configuration still wins. Unsandboxed runs do not load the fallback, so Chrome keeps its own sandbox. See [`examples/browser`](../../examples/browser) for the complete folder.

An agent that still cannot run sandboxed can declare `{ "sandbox": false }` instead. cradle then runs pi bare, warns loudly on every run, and an explicit `--sandbox` flag always forces isolation back on.

## Build Targets

The build produces platform-specific standalone binaries in `dist/`:

- `cradle-macos-arm64`
- `cradle-macos-x64`
- `cradle-linux-x64`
- `cradle-linux-arm64`
- `cradle-windows-x64.exe`

## License

MIT
