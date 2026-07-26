---
{ title: 'Cradle', description: 'A runtime for portable Pi agents defined as folders.', layout: 'index.11ty.js' }
---

# Cradle

<h2 nve-text="heading muted">Your agent as a directory. One pi install, many agents.</h2>

```
my-agent/
  extensions/         optional   pi extensions: custom tools, commands, hooks
  sandbox/            optional   sandbox posture (nono.json, sbx.json)
  skills/             optional   markdown playbooks, loaded when relevant
  settings.json       optional   pi-native settings (model selection)
  models.json         optional   pi-native custom provider definitions
  SYSTEM.md           required   system prompt (role + instructions)
```

```sh
curl -fsSL https://coryrylan.github.io/cradle/install.sh | bash
```

```sh
cradle run ./my-agent
```

Cradle makes it easy to create custom [Pi Agents](https://pi.dev/) via a folder with a `SYSTEM.md` or `APPEND_SYSTEM.md`. Everything else (model config, skills, extensions, sandbox posture) is an optional file you add as the agent grows. `cradle` is the runtime that reads that folder and launches the [pi](https://github.com/earendil-works/pi-mono) coding agent configured from it. Add `sandbox/nono.json` to sandbox that run with [nono](https://github.com/always-further/nono), or `sandbox/sbx.json` to run it inside a [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) microVM instead.
