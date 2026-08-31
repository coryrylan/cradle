---
{ title: 'Commands', description: 'The cradle run and cradle doctor command reference.', layout: 'index.11ty.js' }
---

# Commands

`cradle` has three commands: `run`, which launches an agent, `schedule`, which manages cron-driven runs, and `doctor`, which checks your setup.

## Usage

```sh
cradle --version
cradle doctor                         # check pi (required), nono/sbx/mise (recommended) on PATH, with versions
cradle run ./my-agent               # run an agent folder with pi; sandboxed when sandbox/nono.json or sandbox/sbx.json exists
cradle run my-agent                 # run a name from ~/.cradle/settings.json instead of a path
cradle run . --offline              # block all outbound network (exfil protection)
cradle run . --allow-host api.example.com  # restrict network to these hosts (repeatable)
cradle run . --sandbox-backend sbx  # run under the sbx Docker Sandboxes microVM instead of nono
cradle run . --no-sandbox           # run pi directly (debug)
cradle run . --dry-run -- --resume  # print the write plan + command; forward `--resume` to pi

cradle schedule list ./my-agent              # tasks, cron, next fire, installed?
cradle schedule install ./my-agent           # write + load a native OS timer per task
cradle schedule install ./my-agent --dry-run # print what would be written, touch nothing
cradle schedule run ./my-agent daily-report  # fire one task now, in the foreground
cradle schedule remove ./my-agent [task]     # unload + delete (every task, or one)
```

## How `cradle run` works

The agent runs in _your_ working directory — the agent folder is a parameter (default `.`), not a place cradle changes into. That means an agent folder can live anywhere on disk, or be referenced by a [global alias](../aliases/), while every run still operates on the project in your current shell.

Everything after `--` is forwarded verbatim to `pi`. Use it for `pi`'s own flags, like `--resume` or `-p "prompt"`, without cradle trying to interpret them.

`--dry-run` prints the generated-extension write plan and the composed command without spawning anything — and without requiring `pi`, `nono`, or `sbx` to be installed. For an sbx-backend run it also prints the `sbx create`/`sbx policy`/provision setup commands, in the order `cradle run` would run them, before the final `sbx exec` argv. Use it to see exactly what a run would do before it does it.

Per-agent runtime state — generated extensions and session history — lives under `~/.cradle/agents/<name>-<hash>/`, outside the agent folder itself. That keeps the folder clean and committable: nothing a run writes ends up in your agent's source tree.

## Flags

| Flag                            | Effect                                                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--offline`                     | Block all outbound network for this run. Requesting a network policy only means something inside the sandbox, so this forces the sandbox on too (same as `--sandbox`) unless `--no-sandbox` is also passed. |
| `--allow-host <host>`           | Restrict outbound network to the given host. Repeatable. Forces the sandbox on, same as `--offline`.                                                                                                        |
| `--no-sandbox`                  | Run `pi` directly, without a sandbox wrapper. Useful for debugging. Combined with `--offline`/`--allow-host`, cradle warns the policy has no effect and runs with no network isolation.                     |
| `--sandbox`                     | Force sandboxing on when no `sandbox/` file enables one or the folder opts out.                                                                                                                             |
| `--sandbox-backend <nono\|sbx>` | Sandbox implementation (implies `--sandbox`): `nono` (host OS policy) or `sbx` (Docker Sandboxes microVM).                                                                                                  |
| `--dry-run`                     | Print the write plan and composed command; don't spawn anything.                                                                                                                                            |
| `--verbose`                     | Drop `nono`'s `--silent` flag to show its capabilities banner (nono backend only).                                                                                                                          |
| `-- <args>`                     | Forward everything after `--` to `pi` verbatim.                                                                                                                                                             |

See [Sandbox](../sandbox/) for how `--offline`, `--allow-host`, `--no-sandbox`, `--sandbox-backend`, and a folder's own `sandbox/nono.json`/`sandbox/sbx.json` interact, and [Agent Folders](../agent-folders/) for what cradle reads out of the folder before it runs.

## Doctor

`cradle doctor` checks `pi` (required), and `nono`/`sbx`/`mise` plus your platform's timer backend — `launchctl` on macOS, `systemctl` on Linux — (recommended — each on your `PATH`, with version). `cradle run` reads the agent folder and launches `pi` in your current working directory — sandboxed inside `nono` or `sbx` when the folder declares `sandbox/nono.json`/`sandbox/sbx.json`, bare (with a warning) otherwise.
