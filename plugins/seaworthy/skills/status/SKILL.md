---
name: status
description: Show where the seaworthy loop is in this repository — checks per tier, guard events, review verdict, CI and escalation.
---

# /seaworthy:status

!`node "${CLAUDE_PLUGIN_ROOT}/core/cli.js" status 2>&1 || true`

Summarise this for the developer in two or three lines: what is green, what is blocking, and the one
next step. If guard events are open, list their ids and what each one is.
