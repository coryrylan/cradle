# cradle

![CI Build](https://github.com/coryrylan/cradle/actions/workflows/pull-request.yml/badge.svg)

**A runtime for portable agents defined as folders.** An agent is a directory: an `APPEND_SYSTEM.md` plus optional model config, skills, extensions, and sandbox posture. `cradle start <dir>` reads the folder and launches the [pi](https://github.com/earendil-works/pi-mono) coding agent configured from it — wrapped in the [nono](https://github.com/always-further/nono) filesystem/network sandbox when the folder declares one. Think of cradle as a pi agent switcher: one pi install, many agents, each described entirely by its own directory.

The folder is static, portable, and committable; runtime state (generated extensions, session history, the generated sandbox profile) lives outside it under `~/.cradle/`. An agent folder is code — extensions run with the pi process's permissions — so treat a third-party folder like any repo you'd run.

```sh
cradle doctor              # check pi (required), nono/mise (recommended) on PATH
cradle start ./my-agent    # launch pi as this agent; sandboxed when sandbox/nono.json exists
cradle start ./my-agent --offline       # block all outbound network
cradle start ./my-agent --dry-run       # print the write plan + command, do not spawn
cradle start ./my-agent -- -p "prompt"  # everything after -- is forwarded to pi
```

## Install

Standalone binary to `~/.local/bin/cradle` (macOS and Linux; no Bun required to run it):

```bash
curl -fsSL https://coryrylan.github.io/cradle/install.sh | bash
```

Or the npm package (the command is still `cradle`; [Bun](https://bun.sh) must be on your `PATH`):

```bash
npm install -g @coryrylan/cradle
```

Full install, dependency, and usage details are in the [CLI README](./projects/cli/README.md).

## The agent folder

```
my-agent/
  APPEND_SYSTEM.md   required   the agent's role and instructions
  settings.json      optional   pi-native settings (model selection, packages)
  models.json        optional   pi-native custom provider definitions
  skills/            optional   markdown playbooks, loaded when relevant
  extensions/        optional   pi extensions: custom tools, commands, hooks
  sandbox/           optional   sandbox posture (nono.json)
```

Every supported file uses a pi-native or cross-tool-standard name, mirroring pi's own `~/.pi/agent/` layout — anything written for a personal pi config drops in unchanged. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full folder-format spec and [`examples/`](./examples) for runnable agents:

- [`examples/hello`](./examples/hello) — minimal agent, locked offline to a local Ollama model.
- [`examples/browser`](./examples/browser) — [agent-browser](https://agent-browser.dev/) + Chrome for Testing running sandboxed under nono.

## This repo

Bun workspaces monorepo. Packages live under `projects/`.

- [`projects/cli`](./projects/cli) — `@coryrylan/cradle`, the `cradle` CLI (bin: `cradle`). The runtime itself, built with Bun and TypeScript and compiled to standalone platform binaries.
- [`projects/docs`](./projects/docs) — `@coryrylan/cradle-docs`, the Eleventy + [NVIDIA Elements](https://nvidia.github.io/elements/) documentation site. Deployed statically (it also hosts `install.sh` and the platform binaries); not published to npm.

## Common commands (run at root)

```bash
bun install          # install deps for all workspaces
bun run ci           # format + lint:knip + per-package ci (lint + build + test)
bun run format       # prettier check across the monorepo
bun run format:fix   # prettier write
bun run lint:knip    # knip across all workspaces (unused files / deps / exports)
```

Package-scoped scripts (`build`, `test`, `lint`, …) run inside the package — e.g. `cd projects/cli && bun run build`. See each package's `README.md` and the root [`CLAUDE.md`](./CLAUDE.md) for details.

## License

MIT
