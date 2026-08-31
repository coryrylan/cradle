---
name: Hello heartbeat
description: Verifies the cradle scheduling path end to end on a weekday morning.
cron: '0 9 * * 1-5'
cwd: ~/dev/my-project
---

Call the get-time tool and report the current date and time in one line. This
task exists to prove the scheduling path works end to end — the agent runs
unattended, in the directory named above, with this file's body as its prompt.
