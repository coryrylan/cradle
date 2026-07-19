---
{ title: 'Agent Folders', description: 'The agent folder format, file by file.', layout: 'index.11ty.js' }
---

# Agent Folders

A folder with a `SYSTEM.md` or `APPEND_SYSTEM.md` is a complete agent. Everything else below is optional — add it as the agent grows. Every supported file uses a pi-native or cross-tool-standard name, and the folder mirrors the layout of pi's own agent dir (`~/.pi/agent/`), so anything written for a personal pi config drops in unchanged.

```
my-agent/
  extensions/         optional   pi extensions: custom tools, commands, hooks
  sandbox/            optional   sandbox posture (nono.json)
  skills/             optional   markdown playbooks, loaded when relevant
  settings.json       optional   pi-native settings (model selection)
  models.json         optional   pi-native custom provider definitions
  SYSTEM.md           required*  replace pi's system prompt (role + instructions)
  APPEND_SYSTEM.md    required*  append to pi's system prompt (role + instructions)
```

`*` At least one of `SYSTEM.md` / `APPEND_SYSTEM.md` is required; a folder may ship both.

## SYSTEM.md / APPEND_SYSTEM.md

The agent's role, instructions, and personality in Markdown — pi's system-prompt-file convention, the same names pi discovers in `~/.pi/agent/` and `<project>/.pi/`. Two variants, mirroring pi:

- **`SYSTEM.md`** _replaces_ pi's default coding-assistant prompt (`--system-prompt <path>`) — use it when the agent shouldn't carry pi's built-in assistant framing. Context files and skills are still appended by pi.
- **`APPEND_SYSTEM.md`** _appends_ to pi's default prompt (`--append-system-prompt <path>`) — use it to layer role and instructions on top of the built-in framing.

pi can't discover either file in an arbitrary folder on its own, so cradle passes the paths explicitly. A folder may ship both: cradle passes both flags, and pi uses `SYSTEM.md` as the base with `APPEND_SYSTEM.md` appended. A folder with neither means the directory isn't an agent, and `cradle start` fails with a pointer to this page.

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

Only `npm:<name>[@<version>]` sources are supported — cradle installs each declared package into a private npm project under the agent's state dir before the sandbox spawns, then resolves the installed package's `pi.extensions` entries into explicit `-e` flags. Other pi source forms (`git:`, `https://`, `ssh://`, local paths) are warned and dropped.

`npmCommand` selects the installer, and must be a single-element array naming one of `npm`, `pnpm`, `yarn`, or `bun` — a bare command name, no paths, no flags, no extra argv. The install runs on the host before the sandbox spawns, so a wider shape would let a folder's settings.json run arbitrary host commands; anything else is warned and dropped, falling back to `npm`.

## models.json

pi's native custom-provider format. Define self-hosted or OpenAI-compatible endpoints (Ollama, vLLM, SGLang) exactly as you would in `~/.pi/agent/models.json`; cradle registers each provider at launch via a generated extension.

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

Load order is load-bearing: cradle's generated providers extension loads first (when the agent declares `models.json`), then any `settings.json` `packages` entries, then the agent's own `extensions/` last — they can assume registered providers and any package-provided tools are already available.

> **An agent folder is code.** Extensions execute with the `pi` process's permissions — the `nono` sandbox contains them at the OS boundary, but inside it they are unrestricted. Treat a third-party agent folder with the same scrutiny as a repo you'd run.

## sandbox/nono.json

Sandbox posture — filesystem grants, network policy, and the sandbox opt-out. See [Sandbox](../sandbox/) for the full reference.
