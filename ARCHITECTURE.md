# Architecture

## Your agent is a directory

A folder with a `SYSTEM.md` or `APPEND_SYSTEM.md` is a complete agent. Everything else — model config, skills, extensions, sandbox posture — is an optional file you add as the agent grows. The folder is static and portable; `cradle` is the runtime that reads it and launches the [pi](https://github.com/earendil-works/pi-mono) coding agent configured from it. Think of cradle as a pi agent switcher: one pi install, many agents, each defined entirely by its directory.

```
my-agent/
  SYSTEM.md          required*  replace pi's system prompt with the agent's role + instructions
  APPEND_SYSTEM.md   required*  append the agent's role + instructions to pi's default prompt
  settings.json      optional   pi-native settings (model selection)
  models.json        optional   pi-native custom provider definitions
  skills/            optional   markdown playbooks, loaded when relevant
  extensions/        optional   pi extensions: custom tools, commands, hooks
  sandbox/           optional   sandbox posture (nono.json)
  schedules/         reserved   planned — cron-driven runs
  subagents/         reserved   planned — delegated specialist agents
  channels/          reserved   planned — Slack/Discord/web surfaces
  connections/       reserved   planned — service auth for tools
```

`*` At least one of `SYSTEM.md` / `APPEND_SYSTEM.md` is required; a folder may ship both.

Every supported file uses a pi-native or cross-tool-standard name. The folder mirrors the layout of pi's own agent dir — `~/.pi/agent/` holds the same `SYSTEM.md`, `APPEND_SYSTEM.md`, `settings.json`, `models.json`, `skills/`, and `extensions/` — so anything written for a personal pi config drops in unchanged. The mirror is layout-deep, not key-deep: `settings.json` keys cradle can't deliver over argv (`theme`, `quietStartup`, …) have no effect in an agent folder and warn at start — see [`settings.json`](#settingsjson).

```sh
cradle start ./my-agent                 # launch pi as this agent; sandboxed when sandbox/nono.json exists
cradle start ./my-agent --dry-run       # print the write plan + full command
cradle start ./my-agent --sandbox       # force the nono wrapper
cradle start ./my-agent -- -p "prompt"  # everything after -- is forwarded to pi
```

The agent runs in _your_ working directory (the target project); the agent folder is a parameter. Per-agent runtime state lives outside the folder in `~/.cradle/agents/<name>-<hash>/` (generated extensions + session history), so the source folder stays clean and committable.

## Global agent aliases

`cradle start <ref>` also accepts a bare name instead of a path. A bare name (no `/`, not `.`/`~`-led — see the resolution table below) is looked up in a global name → folder map at `~/.cradle/settings.json`, so `cradle start my-agent` works from any cwd instead of requiring a full path:

```json
{
  "agents": {
    "my-agent": { "path": "~/dev/agents/my-agent/" }
  }
}
```

| Input                                      | Resolution                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `my-agent`                                 | alias table first; falls back to the relative path `./my-agent` only when no alias is defined |
| `./my-agent`, `../x`, `/abs/x`, `~/x`, `.` | always a path — never an alias lookup                                                         |

The alias resolves to an absolute path before `loadAgentFolder` sees it, so folder loading, the state dir, the generated nono profile, and argv composition are all untouched — `cradle start my-agent` and `cradle start ~/dev/agents/my-agent/` share the same state dir and `agentId`. When an alias shadows a same-named directory in your cwd, cradle warns and points at `./my-agent` as the escape hatch; when a bare name matches no alias and no cwd-relative directory either, the error names both misses.

**Config is not state.** `~/.cradle/settings.json`'s path derives from `home` only, entirely apart from `CRADLE_STATE_DIR` (which only ever means the state root described above, never the alias table) — redirecting where session history lives never silently moves where aliases are read from. The filename collides with an agent folder's own pi-native `settings.json`, but they are different files with different schema authorities: cradle owns the global one, so unknown keys there warn as schema errors; an agent folder's `settings.json` stays pi-schema — cradle never validates pi's keys, it warns only that keys it doesn't map won't reach pi.

## File-by-file

### `SYSTEM.md` / `APPEND_SYSTEM.md` (at least one required)

The agent's role, instructions, and personality in Markdown — pi's [system-prompt-file convention](https://pi.dev/docs/latest/usage#system-prompt-files), the same names pi discovers in `~/.pi/agent/` and `<project>/.pi/`. Two variants, mirroring pi:

- **`SYSTEM.md`** _replaces_ pi's default coding-assistant prompt (`--system-prompt <path>`). Use it when the agent should not carry pi's built-in assistant framing. Context files and skills are still appended by pi.
- **`APPEND_SYSTEM.md`** _appends_ to pi's default prompt (`--append-system-prompt <path>`). Use it to layer role and instructions on top of the built-in framing.

A folder may ship both — cradle passes both flags, and pi uses `SYSTEM.md` as the base with `APPEND_SYSTEM.md` appended on top. pi can't discover either file in an arbitrary folder, so cradle passes the paths explicitly; passing a flag also replaces pi's own discovery of that file, so a personal global `~/.pi/agent/SYSTEM.md` or `APPEND_SYSTEM.md` never bleeds into an agent run. A folder with neither file is not an agent; `cradle start` fails with a pointer to this spec (and a rename hint when it finds a legacy `AGENTS.md`, which maps to `APPEND_SYSTEM.md`).

### `settings.json`

pi's native settings shape. v1 honors the model-selection keys and warns on the rest:

```json
{
  "defaultProvider": "ollama",
  "defaultModel": "qwen3.6:27b-mlx",
  "defaultThinkingLevel": "low"
}
```

These are passed explicitly as `--provider`/`--model`/`--thinking`, so the machine's personal pi defaults never bleed into an agent run.

`settings.json` also supports pi's own npm-distributed extension mechanism:

```json
{
  "packages": ["npm:pi-example-tool", "npm:@scope/tool@1.2.0"],
  "npmCommand": ["npm"]
}
```

Only `npm:<name>[@<version>]` sources are supported — pi also accepts `git:`, `https://`, `ssh://`, and local-path sources, but cradle installs the package itself (agent runs pass `--no-extensions`, so pi's own package loader never runs for them), and those other source forms are warned and dropped rather than installed. Before the sandbox spawns, cradle installs each declared package into a private npm project at `<state>/npm` via the `npmCommand` prefix (a single command naming one of `npm`, `pnpm`, `yarn`, or `bun` — a folder can't supply arbitrary installer argv; default `npm`, so `npm install --ignore-scripts` — package lifecycle scripts never run on the host; reinstalled only when the resolved dependency set changes), then resolves each installed package's `package.json` `pi.extensions` entries (falling back to a top-level `index.ts` when a package declares none) into explicit `-e` flags — pi loads explicit `-e` paths even under `--no-extensions`. Any other pi-native setting (`theme`, `quietStartup`, `collapseChangelog`, …) has no effect in an agent folder: pi reads those keys from `~/.pi/agent/settings.json` and the project's `.pi/settings.json`, never from the folder, and exposes no CLI flags cradle could map them to — so cradle warns at start instead of silently dropping them.

### `models.json`

pi's native custom-provider format. Define self-hosted or OpenAI-compatible endpoints (Ollama, vLLM, SGLang) exactly as you would in `~/.pi/agent/models.json`; cradle registers each provider at launch via a generated extension. One normalization: models without a `cost` get pi's zero-cost default filled in — pi's own models.json loader defaults it, but the `registerProvider` extension API requires it.

### `skills/`

Skill directories containing `SKILL.md` ([Agent Skills](https://agentskills.io) format), passed to pi via `--skill`. Loaded only when relevant, so the agent gets focused guidance without carrying it in every prompt.

### `extensions/`

Full [pi extensions](https://github.com/earendil-works/pi-mono), passed through verbatim as `-e <file>`: top-level `extensions/*.ts` plus each subdirectory's `index.ts` — the same shapes pi discovers in `~/.pi/agent/extensions/`, so an extension written for your personal pi config drops in unchanged. One mechanism covers everything the runtime can grow: model-callable tools (`pi.registerTool`), `/commands`, permission gates, event interception, custom providers, custom rendering.

A model-callable tool is the everyday case:

```ts
// extensions/get-time/index.ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'get-time',
    label: 'Get time',
    description: 'Get the current local time',
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: 'text' as const, text: new Date().toString() }], details: {} };
    }
  });
}
```

Load order is load-bearing: cradle's generated providers extension loads first (when the agent declares `models.json`), then any `settings.json` `packages` entries (see below), then the agent's own extensions last — they can assume registered providers and any package-provided tools already available.

**An agent folder is code.** Extensions execute with the pi process's permissions — the nono sandbox contains them at the OS boundary, but inside it they are unrestricted. Treat a third-party agent folder with the same scrutiny as a repo you'd run.

### `sandbox/nono.json`

An agent runs inside the [nono](https://github.com/always-further/nono) sandbox when it declares `sandbox/nono.json`, read-write on your cwd and read on the agent folder. Without that file, cradle runs bare `pi` and prints an OS-isolation warning. The file widens or tightens the sandbox posture declaratively:

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

The `filesystem` block supports `read`, `write`, `allow`, and `unix_socket_dir_bind`. The socket grant permits connect and bind only for direct-child Unix socket paths; keep it scoped to a dedicated directory rather than a broad parent such as `~` or `/tmp`.

Within a sandboxed run, network is **open by default**. The `network` block mirrors nono's canonical profile keys — `block` (deny all outbound), `allow_domain` (host allowlist; presence flips nono to default-deny), `open_port`/`listen_port` (localhost/listen TCP; `open_port: [0]` allows any outbound localhost port on macOS), `network_profile` (named nono policy) — and is folded into the generated profile, enforced by nono's proxy (verified on macOS Seatbelt). An `allow_domain` allowlist blocks localhost too, so a local-model agent must list `localhost` and its `open_port`. Precedence: `--offline` (full block) > `--allow-host <host>` (repeatable allowlist) > `sandbox/nono.json` `network` > open. nono **fails closed**: a malformed `network` key or an unenforceable platform makes the run refuse to start, so cradle never ships a do-nothing allowlist. `--offline`/`--allow-host` request a network policy, and a policy is only enforceable inside the sandbox, so either flag forces the sandbox ON (same as `--sandbox`) unless `--no-sandbox` is passed explicitly — in that case cradle warns `network policy has no effect without the sandbox — pi runs with no network isolation (--sandbox to enforce it)` and runs pi bare.

On macOS, a folder can also append raw Seatbelt rules for capabilities the conservative base denies:

```json
{
  "unsafe_macos_seatbelt_rules": ["(allow mach-register)", "(allow iokit-open)"]
}
```

Each entry is an s-expression merged verbatim after the base profile's rules (Seatbelt is last-match-wins). cradle shape-checks that each is parenthesized (warn-and-drop otherwise, like a malformed grant), and nono validates the syntax at profile load. All rules are merged into the generated nono profile; audit an agent folder's `sandbox/nono.json` and the written profile to review them — each one widens the OS sandbox, so a third-party folder shipping them deserves scrutiny. Ignored on Linux. These two rules are the seatbelt half of what lets [agent-browser](https://agent-browser.dev/) + Chrome for Testing run **sandboxed**: `mach-register` for Chrome's Crashpad Mach handshake and `iokit-open` for the IOKit user clients it opens at startup. The complete recipe grants `allow` and `unix_socket_dir_bind` on `~/.agent-browser`, sets `open_port: [0]` for Chrome's random localhost DevTools port, then launches Chrome with `--no-sandbox` — its own nested sandbox can't initialize inside nono's seatbelt (macOS forbids nesting). The filesystem/network boundaries stay fully enforced either way. See the CLI README and [`examples/browser`](./examples/browser) for the complete recipe.

An agent that _still_ cannot run sandboxed can declare the opt-out in the same file:

```json
{
  "sandbox": false
}
```

Sandbox precedence is explicit `--sandbox`/`--no-sandbox` CLI flag > folder `sandbox/nono.json` > restrictive network flags (`--offline`, `--allow-host`, which force the sandbox ON) > unsandboxed default. A folder-driven opt-out is loud — cradle prints `warning: sandbox disabled by sandbox/nono.json …` on every run — and a missing `sandbox/nono.json` similarly warns that pi has no OS isolation (a `sandbox/` dir lacking `nono.json` warns at load too). `--sandbox` always forces isolation back on; its profile uses the folder's grants when present. Treat a third-party folder that ships `"sandbox": false` with exactly the scrutiny that warning implies: it runs pi with no OS isolation.

Cradle doesn't keep a shared global nono profile. On each run it **generates a per-agent profile** into `~/.cradle/agents/<id>/nono-profile.json` — the embedded `cradle-pi` base (which `extends` nono's built-in `default`, pulls the `node_runtime`, `git_config`, and `unlink_protection` groups, and grants the mise/pi/gh/`say` paths every agent needs) merged with this run's grants: your cwd, the agent folder, the state dir, the `sandbox/nono.json` `read`/`write`/`allow`/`unix_socket_dir_bind` entries above (`~`/`$HOME` expanded), and any `unsafe_macos_seatbelt_rules` (appended after the base's). When the cwd is a linked git worktree or submodule checkout, the `.git` pointer file's resolved shared git dir is granted too — without it every sandboxed git command (and any project hook shelling out to git) fails with `fatal: not a git repository`, since the real git dir lives outside the cwd. Cradle then runs `nono run --silent --profile ~/.cradle/agents/<id>/nono-profile.json …` by default (silent mode suppresses nono's startup banner); `--verbose` drops `--silent` to show nono's capabilities banner, and cradle prints `🔒 Sandbox Active` on silent sandboxed runs. So an agent's entire sandbox posture is described by its own directory — nothing is stored globally, and each agent gets a distinct profile (no cross-agent collisions). The resolved `network` posture is baked into the profile's `network` block too (no `--block-net` flag). Grant `allow`/`read`/`write` paths tightly: nono refuses to start if a grant overlaps its own state root (`~/.local/state/nono`), so never grant `/Users` or `~/`.

## How cradle composes the pi invocation

Cradle translates the folder into explicit pi flags — never into files inside `~/.pi/agent`:

| Agent folder                      | pi mechanism                                                   |
| --------------------------------- | -------------------------------------------------------------- |
| `SYSTEM.md`                       | `--system-prompt <path>` (replaces pi's default prompt)        |
| `APPEND_SYSTEM.md`                | `--append-system-prompt <path>` (appends to it)                |
| `settings.json` model keys        | `--provider` / `--model` / `--thinking`                        |
| `models.json`                     | generated `-e` extension → `pi.registerProvider(…)`            |
| `settings.json` `packages`        | per-agent npm install → each package's `pi.extensions` as `-e` |
| `skills/`                         | `--skill <dir>`                                                |
| `extensions/`                     | `-e <file>` per extension, verbatim, loaded last               |
| session history                   | `--session-dir ~/.cradle/agents/<id>/sessions`                 |
| isolation from personal pi config | `--no-extensions --no-skills --no-prompt-templates`            |

Generated extensions land in `~/.cradle/agents/<id>/extensions/` (regenerated every run) with the agent folder's absolute paths baked in as constants.

### Why argv composition instead of `PI_CODING_AGENT_DIR`

pi supports redirecting its whole agent home via the `PI_CODING_AGENT_DIR` env var — the obvious hermetic design. Cradle uses argv instead: argv survives sandboxing regardless of environment handling, so one composition path runs identically sandboxed and unsandboxed. Historically this was load-bearing, not just tidy: pi ≤ 0.80.6 shipped on Bun 1.3.10, whose [bun#27802](https://github.com/oven-sh/bun/issues/27802) emptied `process.env` inside the nono seatbelt whenever cwd sat under `$HOME` (the normal case), and pi resolves its agent dir before extensions load, so nothing could repair a dropped env var after the fact. Bun fixed this silently in 1.3.12 (the issue remains open upstream); pi 0.80.7 is the first release on a fixed Bun (1.3.14).

Consequences, accepted for v1:

- pi still reads the personal `~/.pi/agent/settings.json` (cosmetics like theme — the only place those keys apply; the folder's own copies warn, see [`settings.json`](#settingsjson)), shares its `auth.json`, and writes trust decisions to the personal `trust.json`. Model selection never leaks: agent-defined provider/model/thinking are always passed explicitly.
- `--no-extensions` also disables the _personal_ `~/.pi/agent/settings.json`'s own `packages` inside agent runs — those never load, intentional isolation. This is distinct from an agent folder's own `settings.json` `packages`, which cradle resolves and installs itself (see [`settings.json`](#settingsjson) above) and loads via explicit `-e` flags, since explicit `-e` paths load even under `--no-extensions`.
- Project context files (`AGENTS.md`/`CLAUDE.md` in your cwd) still load; that's the target project's context and it's desirable.

One env var breaks the argv-only rule on purpose: sandboxed runs export `MISE_CACHE_DIR=~/.cradle/agents/<id>/mise-cache`. The generated per-agent profile deliberately denies the shared `~/Library/Caches/mise` — a poisoned `bin_paths` cache written there would redirect which binaries the user's later, unsandboxed mise execs resolve to, invisibly and machine-globally. Without an override, every sandboxed `mise exec` (which pi/nono resolution can trigger via mise shims) fails to write that cache and spams `mise WARN failed to write cache file`. Pointing `MISE_CACHE_DIR` at a private cache inside the already-granted state dir instead gives mise a location it can write to — warnings gone, cache works — without ever exposing the shared host cache to a sandboxed process. mise creates the directory itself; cradle never pre-creates or wipes it. This doesn't undermine the argv rationale above: it configures mise, not pi, and pi's own configuration stays entirely on argv. The failure mode if this env var were ever stripped is benign — mise falls back to the shared cache and the warnings return, nothing breaks.

## Order of support

1. `SYSTEM.md` / `APPEND_SYSTEM.md` — v1
2. `settings.json` / `models.json` — v1
3. `skills/` — v1
4. `extensions/` — v1
5. `sandbox/` — v1
6. `schedules/` — planned: cron-driven durable runs (daily reports, digests)
7. `subagents/` — planned: delegated specialist agents
8. `channels/` — planned: the same agent on Slack, Discord, Teams, web
9. `connections/` — planned: service auth (GitHub, Stripe, Linear) for tools

Future dirs (`schedules/`, `subagents/`, `channels/`, `connections/`) will land as sugar over the same substrate: generated or pass-through pi extensions.
