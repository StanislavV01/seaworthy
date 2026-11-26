---
name: stop
description: End the seaworthy session in this worktree and switch every gate off (developer only).
disable-model-invocation: true
---

# /seaworthy:stop

!`node "${CLAUDE_PLUGIN_ROOT}/core/cli.js" stop 2>&1 || true`

Tell the developer the result above in one line. The gates are off: normal Claude Code behaviour
resumes, and a new loop starts with `/seaworthy:ship`.
