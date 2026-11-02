---
{ title: 'Agent Folders', description: 'The agent folder format, file by file.', layout: 'index.11ty.js' }
---

# Agent Folders

A folder with a `SYSTEM.md` or `APPEND_SYSTEM.md` is a complete agent. Everything else below is optional — add it as the agent grows. Every supported file uses a pi-native or cross-tool-standard name, and the folder mirrors the layout of pi's own agent dir (`~/.pi/agent/`), so anything written for a personal pi config drops in unchanged.

```
my-agent/
  extensions/         optional   pi extensions: custom tools, commands, hooks
  sandbox/            optional   sandbox posture (nono.json)
  schedule/           optional   cron-driven scheduled runs
  skills/             optional   markdown playbooks, loaded when relevant
  settings.json       optional   pi-native settings (model selection)
  models.json         optional   pi-native custom provider definitions
  mcp.json           optional   pi-native MCP server definitions
  SYSTEM.md           required*  replace pi's system prompt (role + instructions)
  APPEND_SYSTEM.md    required*  append to pi's system prompt (role + instructions)
```

`*` At least one of `SYSTEM.md` / `APPEND_SYSTEM.md` is required; a folder may ship both.

## SYSTEM.md / APPEND_SYSTEM.md

The agent's role, instructions, and personality in Markdown — pi's system-prompt-file convention, the same names pi discovers in `~/.pi/agent/` and `<project>/.pi/`. Two variants, mirroring pi:

- **`SYSTEM.md`** _replaces_ pi's default coding-assistant prompt (`--system-prompt <path>`) — use it when the agent shouldn't carry pi's built-in assistant framing. Context files and skills are still appended by pi.
- **`APPEND_SYSTEM.md`** _appends_ to pi's default prompt (`--append-system-prompt <path>`) — use it to layer role and instructions on top of the built-in framing.

pi can't discover either file in an arbitrary folder on its own, so cradle passes the paths explicitly. A folder may ship both: cradle passes both flags, and pi uses `SYSTEM.md` as the base with `APPEND_SYSTEM.md` appended. A folder with neither means the directory isn't an agent, and `cradle run` fails with a pointer to this page.

## settings.json

pi's native settings shape. cradle honors the model-selection keys:

```json
{
  "defaultProvider": "ollama",
  "defaultModel": "qwen3.6:27b-mlx",
  "defaultThinkingLevel": "low"
}
```

These are passed explicitly as `--provider`/`--model`/`--thinking`, so your machine's personal pi defaults never bleed into an agent run.

Keys cradle doesn't map (`theme`, `quietStartup`, `collapseChangelog`, …) have no effect in an agent folder — pi reads them from `~/.pi/agent/settings.json` or the project's `.pi/settings.json`, never from the folder, and cradle warns at start so they don't silently disappear.

`settings.json` also supports pi's npm-distributed extension mechanism:

```json
{
  "packages": ["npm:pi-example-tool", "npm:@scope/tool@1.2.0"],
  "npmCommand": ["npm"]
}
```

Only `npm:<name>[@<version>]` sources are supported — cradle installs each declared package into a private npm project under the agent's state dir before the sandbox spawns, then resolves the installed package's extensions into explicit `-e` flags: the `pi.extensions` entries its `package.json` declares (files, directories, or globs), else a convention `extensions/` directory, else a top-level `index.ts`/`index.js`. Other pi source forms (`git:`, `https://`, `ssh://`, local paths) are warned and dropped.

pi's object form picks which of those extensions load:

```json
{
  "packages": [
    { "source": "npm:pi-multi-tool", "extensions": ["extensions/*.ts", "!extensions/legacy.ts"] },
    { "source": "npm:pi-big-tool", "autoload": false, "extensions": ["+extensions/review.ts"] }
  ]
}
```

Omit `extensions` to load everything the package declares, `[]` to load none, or list patterns: a plain glob includes, `!` excludes, `+` force-includes an exact path, `-` force-excludes one — all relative to the package root. `"autoload": false` flips the default so nothing loads except what a pattern names. The sibling `skills`, `prompts`, and `themes` filters are accepted and warned as ignored: cradle delivers a package's extensions and nothing else.

`npmCommand` selects the installer, and must be a single-element array naming one of `npm`, `pnpm`, `yarn`, or `bun` — a bare command name, no paths, no flags, no extra argv. The install runs on the host before the sandbox spawns, so a wider shape would let a folder's settings.json run arbitrary host commands; anything else is warned and dropped, falling back to `npm`.

## models.json

pi's native custom-provider format. Define self-hosted or OpenAI-compatible endpoints (Ollama, vLLM, SGLang) exactly as you would in `~/.pi/agent/models.json`; cradle registers each provider at launch via a generated extension.

## mcp.json

Cradle loads Pi’s built-in MCP, codemode, and tool-search extensions explicitly while keeping `--no-extensions` for other personal extensions. This requires Pi 1.4.0 or newer. Personal `~/.pi/agent/mcp.json` and trusted project `.pi/mcp.json` configurations remain available.

`mcp.json` in the agent folder adds session-local servers through a generated `mcp.ts` extension using `pi.registerMcpServer`. The file must contain an `mcpServers` object:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

Pi validates each server and manages stdio/streamable HTTP connections, environment substitution, OAuth, and tool exposure. A rejected registration warns without preventing the other servers from loading. Relative server working directories and arguments use the session’s working directory, not the agent folder.

Personal and trusted project file configurations override agent registrations with the same server name, following Pi’s extension-registration rules. Agent registrations are session-local: `pi mcp list` does not show them. Use `/mcp` inside the Cradle session to inspect connections; server changes take effect on the next Cradle launch. File-level options such as `autoEnableCodemode` are not mapped from the agent file and warn as unsupported; configure them in Pi’s personal or project `mcp.json`.

MCP servers receive the run’s existing sandbox grants and network policy. Cradle does not widen them automatically. Disable built-in MCP for one run with `cradle run ./my-agent -- --no-mcp`. See [Pi’s MCP documentation](https://pi.dev/docs/latest/mcp) for server configuration fields.

## skills/

Skill directories containing `SKILL.md` ([Agent Skills](https://agentskills.io) format), passed to `pi` via `--skill`. Loaded only when relevant, so the agent gets focused guidance without carrying it in every prompt.

## extensions/

Full pi extensions, passed through verbatim as `-e <file>`: top-level `extensions/*.ts` plus each subdirectory's `index.ts` — the same shapes pi discovers in `~/.pi/agent/extensions/`. One mechanism covers everything the runtime can grow: model-callable tools (`pi.registerTool`), `/commands`, permission gates, event interception, custom providers, custom rendering.

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

Cradle loads Pi’s MCP built-ins first, then generated provider and MCP registrations, the nono fallback when sandboxed, host terminal hooks, package extensions, and the agent’s own extensions last.

> **An agent folder is code.** Extensions execute with the `pi` process's permissions — the `nono` sandbox contains them at the OS boundary, but inside it they are unrestricted. Treat a third-party agent folder with the same scrutiny as a repo you'd run.

## sandbox/nono.json

Sandbox posture — filesystem grants, network policy, and the sandbox opt-out — for the [nono](https://github.com/nolabs-ai/nono) host-OS-policy backend. See [Sandbox](../sandbox/) for the full reference.
