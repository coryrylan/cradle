---
{ title: 'Commands', description: 'The cradle start and cradle doctor command reference.', layout: 'index.11ty.js' }
---

# Commands

`cradle` has two commands: `start`, which launches an agent, and `doctor`, which checks your setup.

## Usage

```sh
cradle --version
cradle doctor                         # check pi (required), nono/mise (recommended) on PATH, with versions
cradle start ./my-agent               # run an agent folder with pi; sandboxed when sandbox/nono.json exists
cradle start my-agent                 # run a name from ~/.cradle/settings.json instead of a path
cradle start . --offline              # block all outbound network (exfil protection)
cradle start . --allow-host api.z.ai  # restrict network to these hosts (repeatable)
cradle start . --no-sandbox           # run pi directly (debug)
cradle start . --dry-run -- --resume  # print the write plan + command; forward `--resume` to pi
```

## How `cradle start` works

The agent runs in _your_ working directory — the agent folder is a parameter (default `.`), not a place cradle changes into. That means an agent folder can live anywhere on disk, or be referenced by a [global alias](../aliases/), while every run still operates on the project in your current shell.

Everything after `--` is forwarded verbatim to `pi`. Use it for `pi`'s own flags, like `--resume` or `-p "prompt"`, without cradle trying to interpret them.

`--dry-run` prints the generated-extension write plan and the composed `pi`/`nono` command without spawning anything — and without requiring `pi` or `nono` to be installed. Use it to see exactly what a run would do before it does it.

Per-agent runtime state — generated extensions and session history — lives under `~/.cradle/agents/<name>-<hash>/`, outside the agent folder itself. That keeps the folder clean and committable: nothing a run writes ends up in your agent's source tree.

## Flags

| Flag                  | Effect                                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--offline`           | Block all outbound network for this run. Requesting a network policy only means something inside the sandbox, so this forces the sandbox on too (same as `--sandbox`) unless `--no-sandbox` is also passed. |
| `--allow-host <host>` | Restrict outbound network to the given host. Repeatable. Forces the sandbox on, same as `--offline`.                                                                                                        |
| `--no-sandbox`        | Run `pi` directly, without the `nono` wrapper. Useful for debugging. Combined with `--offline`/`--allow-host`, cradle warns the policy has no effect and runs with no network isolation.                    |
| `--sandbox`           | Force sandboxing on, including when `sandbox/nono.json` is absent.                                                                                                                                          |
| `--dry-run`           | Print the write plan and composed command; don't spawn anything.                                                                                                                                            |
| `--verbose`           | Drop `nono`'s `--silent` flag to show its capabilities banner.                                                                                                                                              |
| `-- <args>`           | Forward everything after `--` to `pi` verbatim.                                                                                                                                                             |

See [Sandbox](../sandbox/) for how `--offline`, `--allow-host`, `--no-sandbox`, and a folder's own `sandbox/nono.json` interact, and [Agent Folders](../agent-folders/) for what cradle reads out of the folder before it runs.

## Doctor

`cradle doctor` checks that `pi` and `nono` are on your `PATH`. `cradle start` reads the agent folder and launches `pi` in your current working directory — sandboxed inside `nono` when the folder declares `sandbox/nono.json`, bare (with a warning) otherwise.
