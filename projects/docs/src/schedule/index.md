---
{
  title: 'Schedules',
  description: 'Cron-driven agent runs defined as files in the agent folder, installed as native OS timers.',
  layout: 'index.11ty.js'
}
---

# Schedules

A `schedule/` directory turns an agent into something that runs on its own. Each `schedule/<task>.md` is one task: YAML frontmatter saying when it fires and where, and a Markdown body that becomes the prompt.

```yaml
---
name: Daily standup report
description: Summarize yesterday's commits and open PRs.
cron: '0 9 * * 1-5'
cwd: ~/dev/my-project
---
```

Everything below the closing `---` is the prompt, verbatim.

| Key | Required | Meaning |
| --- | --- | --- |
| `cron` | yes | five-field expression, or an `@hourly` / `@daily` / `@weekly` / `@monthly` / `@yearly` macro |
| `cwd` | yes | the directory the run starts in — absolute, `~/`, or `$HOME/` |
| `name` | no | display label for `cradle schedule list` and the session name; defaults to the filename |
| `description` | no | shown in `cradle schedule list` |

The filename is the task's identity — `daily-report.md` is the task `daily-report` — so it must be a bare name: letters, digits, `.`, `-`, `_`. It becomes a launchd label and a systemd unit name, which is why the shape is enforced.

A malformed task is dropped with a warning rather than failing the whole directory; one broken schedule never stops the others from loading.

## Commands

```sh
cradle schedule list ./my-agent                # tasks, cron, next fire
cradle schedule install ./my-agent             # write + load every task's timer
cradle schedule install ./my-agent --dry-run   # print what would be written, touch nothing
cradle schedule run ./my-agent daily-report    # fire once now, in the foreground
cradle schedule remove ./my-agent              # unload + delete
cradle schedule remove ./my-agent daily-report # unload + delete one task
```

Every subcommand takes the same agent reference `cradle run` does, so a [global alias](../aliases/) works in place of a path:

```sh
cradle schedule list assistant
cradle schedule install assistant
```

The alias is resolved to an absolute path *before* the timer is written, and that absolute path is what the timer records. An installed task keeps firing correctly even if you later rename the alias or remove it from `~/.cradle/settings.json`.

`cradle schedule run` is what an installed timer itself invokes — there is one way to run a task, whether you type it or launchd does. It is an ordinary agent run with the task's `cwd` as the working directory and the task's body as the prompt, so reproducing a scheduled run by hand is the same command the machine uses.

## What a scheduled run can do

A scheduled run is an ordinary `cradle run`, so it adds no new sandbox policy. `cwd` is granted read and write exactly as it is when you `cd` there and start the agent yourself — a task that should produce a file just says so in its prompt:

```markdown
Summarize yesterday's commits and write the result to ./reports/standup.md.
```

Writing outside `cwd` still needs an explicit grant in `sandbox/nono.json`. Nothing in `schedule/` widens what an agent can reach.

Skills need no wiring. The agent's own `skills/` directory is already loaded, so a task body names a skill exactly as you would in an interactive turn.

Runs are non-interactive and pass pi's `--no-approve`, so an unattended job never blocks on a trust prompt for a project-local `.pi/` — and never silently trusts one either. Output is captured at `~/.cradle/agents/<id>/schedule/<task>.log`.

## Cron expressions

Each field accepts `*`, a number, a range (`1-5`), a step (`*/15`, `0-30/10`), or a comma-separated list. Month and day names work too, case-insensitively: `0 9 * * mon-fri`.

| Expression | Fires |
| --- | --- |
| `0 9 * * *` | every day at 09:00 |
| `0 9 * * 1-5` | weekdays at 09:00 |
| `*/15 * * * *` | every 15 minutes |
| `0 0 1 * *` | midnight on the 1st of each month |
| `@daily` | midnight every day |

Two expressions are rejected outright rather than silently mistranslated:

- **Both day-of-month and day-of-week constrained**, such as `0 0 1 * 1`. Cron treats those two fields as OR — "the 1st, *or* any Monday" — while launchd and systemd both AND them. Neither timer can express the OR, so cradle refuses the expression instead of installing a timer that fires on the wrong days.
- **An expression whose launchd expansion exceeds 500 calendar entries.** launchd has no step syntax, so a step has to be expanded into one entry per occurrence; a pathological expression would otherwise write a multi-megabyte plist.

## macOS

`cradle schedule install` writes one LaunchAgent per task and loads it:

```text
~/Library/LaunchAgents/com.cradle.<agent-id>.<task>.plist
```

launchd is used rather than cron because it runs a missed calendar job after the Mac wakes, where cron silently skips it. The plist records an absolute path to the `cradle` binary and an explicit `PATH`, because launchd loads no shell profile.

```sh
launchctl print gui/$(id -u)/com.cradle.<agent-id>.<task>   # inspect a loaded task
```

## Linux

One `.service` and `.timer` pair per task:

```text
~/.config/systemd/user/cradle-<agent-id>-<task>.service
~/.config/systemd/user/cradle-<agent-id>-<task>.timer
```

The timer sets `Persistent=true`, systemd's equivalent of launchd's wake catch-up: a run missed while the machine was off fires once on next boot.

```sh
systemctl --user list-timers                    # inspect loaded tasks
```

User timers only fire while you have an active session unless lingering is enabled. `cradle schedule install` checks this and prints the fix if it is off:

```sh
loginctl enable-linger $USER
```

## Windows

Scheduled tasks are not supported on Windows; `cradle schedule` reports this rather than installing anything. The rest of the CLI is unaffected.
