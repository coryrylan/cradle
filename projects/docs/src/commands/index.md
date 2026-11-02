---
{ title: 'Commands', description: 'The cradle run and cradle doctor command reference.', layout: 'index.11ty.js' }
---

# Commands

`cradle` has three commands: `run`, which launches an agent, `schedule`, which manages cron-driven runs, and `doctor`, which checks your setup.

## Usage

```sh
cradle --version
cradle doctor                         # check pi (required), nono/mise (recommended) on PATH, with versions
cradle run ./my-agent               # run an agent folder with pi; sandboxed when sandbox/nono.json exists
cradle run my-agent                 # run a name from ~/.cradle/settings.json instead of a path
cradle run . --offline              # block all outbound network (exfil protection)
cradle run . --allow-host api.example.com  # restrict network to these hosts (repeatable)
cradle run . --no-sandbox           # run pi directly (debug)
cradle run . --dry-run -- --resume  # print the write plan + command; forward `--resume` to pi

cradle schedule list ./my-agent              # tasks, cron, next fire, timer status
cradle schedule install ./my-agent           # write + load a native OS timer per task
cradle schedule install ./my-agent --dry-run # print what would be written, touch nothing
cradle schedule run ./my-agent daily-report  # fire one task now, in the foreground
cradle schedule remove ./my-agent [task]     # unload + delete (every task, or one)
```

## How `cradle run` works

The agent runs in _your_ working directory by default — the agent folder is a parameter (default `.`), not a place cradle changes into. A [global alias](../aliases/) can set an optional startup `cwd` for named runs; a scheduled task's `cwd` takes precedence. `--dry-run` prints the generated-extension write plan and the composed command without spawning anything or requiring `pi` or `nono` to be installed.

Everything after `--` is forwarded verbatim to `pi`. Use it for `pi`'s own flags, like `--resume` or `-p "prompt"`, without cradle trying to interpret them.

Per-agent runtime state — generated extensions and session history — lives under `~/.cradle/agents/<name>-<hash>/`, outside the agent folder itself. That keeps the folder clean and committable: nothing a run writes ends up in your agent's source tree.

## MCP servers

Cradle enables Pi’s built-in MCP, codemode, and tool-search support. Add `mcp.json` to an agent folder to register its servers; personal and trusted project MCP configurations also apply. Use `/mcp` inside the session to inspect connections. Pass `-- --no-mcp` to disable built-in MCP for one run. See [Agent Folders](../agent-folders/#mcpjson) for configuration and precedence.

## Herdr and Moshi

On macOS and Linux, `cradle run` automatically loads your installed Herdr and Moshi Pi hooks when their daemon sockets exist. Run agents normally inside Herdr; no per-agent extension copies or extra `-e` arguments are required. Other personal Pi extensions remain disabled.

Cradle reads `herdr-agent-state.ts` and `moshi-hooks.ts` from `~/.pi/agent/extensions/` (`PI_CODING_AGENT_DIR` overrides the Pi directory). Herdr requires its pane environment and `HERDR_SOCKET_PATH`; Moshi follows `MOSHI_SOCKET_PATH` or its platform socket location. Install Herdr's Pi integration with `herdr integration install pi`, and install Moshi's Pi hook through moshi-hook.

Nono receives connect-only access to the exact socket files. The generated profile records those grants, and `--dry-run` shows the loaded hooks and Herdr detection hint. Scheduled runs exclude these integrations.

## Flags

| Flag                            | Effect                                                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--offline`                     | Block all outbound network for this run. Requesting a network policy only means something inside the sandbox, so this forces the sandbox on too (same as `--sandbox`) unless `--no-sandbox` is also passed. |
| `--allow-host <host>`           | Restrict outbound network to the given host. Repeatable. Forces the sandbox on, same as `--offline`.                                                                                                        |
| `--no-sandbox`                  | Run `pi` directly, without a sandbox wrapper. Useful for debugging. Combined with `--offline`/`--allow-host`, cradle warns the policy has no effect and runs with no network isolation.                     |
| `--sandbox`                     | Force sandboxing on when no `sandbox/` file enables one or the folder opts out.                                                                                                                             |
| `--dry-run`                     | Print the write plan and composed command; don't spawn anything.                                                                                                                                            |
| `--verbose`                     | Drop `nono`'s `--silent` flag to show its capabilities banner.                                                                                                                          |
| `-- <args>`                     | Forward everything after `--` to `pi` verbatim.                                                                                                                                                             |

See [Sandbox](../sandbox/) for how `--offline`, `--allow-host`, `--no-sandbox`, and a folder’s `sandbox/nono.json` interact.

## Doctor

`cradle doctor` checks `pi` (required), `nono`/`mise`, and your platform’s timer backend — `launchctl` on macOS, `systemctl` on Linux — (recommended, each with its resolved path and version). `cradle run` launches `pi` in your current working directory or the alias’s configured `cwd`, sandboxed through nono when `sandbox/nono.json` enables it, bare with a warning otherwise.
