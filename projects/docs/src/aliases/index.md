---
{
  title: 'Aliases',
  description: 'Global agent aliases so you can start an agent by name from any working directory.',
  layout: 'index.11ty.js'
}
---

# Aliases

`cradle run <ref>` accepts a bare name instead of a path. A bare name is looked up in a global name → folder map at `~/.cradle/settings.json`, so agents you keep far from any project don't need a full path from every working directory:

```json
{
  "agents": {
    "my-agent": { "path": "~/dev/agents/my-agent/" }
  }
}
```

With that in place, `cradle run my-agent` works from anywhere.

## Resolution

| Input                                      | Resolution                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `my-agent`                                 | Checked against the alias table first; falls back to the relative path `./my-agent` only when no alias is defined. |
| `./my-agent`, `../x`, `/abs/x`, `~/x`, `.` | Always a path — never looked up as an alias.                                                                       |

A bare name is anything without a path separator that doesn't start with `.` or `~`. Anything already path-shaped skips the alias table entirely.

The alias resolves to an absolute path before the agent folder loads, so folder loading, the state dir, the generated `nono` profile, and the composed command are all untouched — `cradle run my-agent` and `cradle run ~/dev/agents/my-agent/` share the same state dir and agent ID.

## Shadowing

When an alias shadows a same-named directory in your current working directory, cradle warns and points at `./my-agent` as the escape hatch to reach the local directory instead of the alias.

When a bare name matches neither an alias nor a cwd-relative directory, the error names both misses so you know which lookup failed.

## Config is not state

`~/.cradle/settings.json`'s path derives from your home directory only, entirely apart from `CRADLE_STATE_DIR` (which controls where session history and generated extensions live — see [Commands](../commands/)). Redirecting where state lives never silently moves where aliases are read from.

The filename collides with an agent folder's own pi-native `settings.json`, but they're different files with different schema authorities: cradle owns the global alias file, so an unknown key there warns. An agent folder's own `settings.json` is pi's schema — cradle stays silent on keys it doesn't recognize there and defers to pi.
