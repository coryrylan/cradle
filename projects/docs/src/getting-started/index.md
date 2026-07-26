---
{
  title: 'Getting Started',
  description: 'Install the dependencies cradle needs, then run and create your first agent folder.',
  layout: 'index.11ty.js'
}
---

# Getting Started

`cradle` drives external tools rather than bundling them. Install these first.

## Dependencies

| Tool                                              | Status      | Why                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`pi`](https://github.com/earendil-works/pi-mono) | Required    | The coding agent cradle launches. Every `cradle run` spawns it.                                                                                                                                                                                                                   |
| [`nono`](https://github.com/always-further/nono)  | Recommended | The filesystem sandbox pi runs inside for a nono-backend run — a folder declaring `sandbox/nono.json`, or `--sandbox`/`--sandbox-backend nono`/`--offline`/`--allow-host`. Required for that run, not needed otherwise.                                                             |
| [`sbx`](https://docs.docker.com/ai/sandboxes/)    | Recommended | The Docker Sandboxes microVM pi runs inside for an sbx-backend run — a folder declaring `sandbox/sbx.json`, or `--sandbox-backend sbx`. Required for that run, not needed otherwise. Install via `brew install docker/tap/sbx`; one-time setup: `sbx login` then `sbx policy init`. |
| [`mise`](https://mise.jdx.dev)                    | Recommended | The supported way to install and manage `pi` and `nono`. cradle resolves both through mise's shims, and the generated sandbox profile grants mise's trees so a sandboxed `pi` finds its runtime.                                                                                    |

## Install cradle

Install the standalone binary to `~/.local/bin/cradle` (macOS and Linux):

```sh
curl -fsSL https://coryrylan.github.io/cradle/install.sh | bash
```

Alternatively, install the npm package [`@coryrylan/cradle`](https://www.npmjs.com/package/@coryrylan/cradle) — the installed command is still `cradle`, and [Bun](https://bun.sh) must be on your `PATH` to run it:

```sh
npm install -g @coryrylan/cradle
```

## Check your setup

Run `cradle doctor` to confirm what's on your `PATH`:

```sh
cradle doctor
```

It reports each tool's resolved path and version. Only `pi` is required. `nono`/`sbx` are each required only for a run on their backend — a folder declaring `sandbox/nono.json`/`sandbox/sbx.json`, or `--sandbox`/`--sandbox-backend`/`--offline`/`--allow-host` on the command line; `mise` is recommended.

## Create your first agent

An agent folder needs just one file to be valid: a `SYSTEM.md` or an `APPEND_SYSTEM.md`. `APPEND_SYSTEM.md` _adds_ the agent's role to pi's built-in coding-assistant prompt; `SYSTEM.md` _replaces_ that prompt entirely. Start with `APPEND_SYSTEM.md` — create a directory and drop in the agent's role and instructions as plain Markdown:

```sh
mkdir -p ~/dev/agents/my-agent
```

```md
<!-- ~/dev/agents/my-agent/APPEND_SYSTEM.md -->

# My Agent

You are My Agent, a focused assistant for <task>.

- Keep answers short and concrete.
- Prefer <tool> over <alternative> when both apply.
```

That's a complete agent. Everything else — model selection, skills, extensions, sandbox posture — is an optional file you add as the agent grows; see [Agent Folders](../agent-folders/) for the full format.

## Run it

```sh
cradle run ~/dev/agents/my-agent
```

`cradle` runs `pi` configured from that folder in your current working directory — not inside the agent folder. Add `sandbox/nono.json` to run it sandboxed by `nono`, or `sandbox/sbx.json` to run it inside the `sbx` Docker Sandboxes microVM instead; otherwise cradle warns and runs bare `pi`. The agent folder is just a parameter; your project stays the target.

To preview what would happen without spawning anything:

```sh
cradle run ~/dev/agents/my-agent --dry-run
```

See [Commands](../commands/) for the full flag reference.
