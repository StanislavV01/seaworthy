---
name: init
description: Set up seaworthy in this repository — detect the project's lint, typecheck, test and build checks, compare them with CI, write .seaworthy.json and install the git hooks backstop.
disable-model-invocation: true
---

# /seaworthy:init

What seaworthy found in this repository:

!`node "${CLAUDE_PLUGIN_ROOT}/core/cli.js" init 2>&1 || true`

1. Show the developer this summary in a short table: package manager, each check and its command,
   the three tiers (fast / commit / push), and every warning (CI steps with no local check, local
   checks that CI does not run).
2. Ask the developer to confirm, or to tell you which commands to change.
3. When they confirm, run `seaworthy init --yes` (or `seaworthy init --yes --force` if a
   `.seaworthy.json` already exists and they want to replace it). This writes `.seaworthy.json` and
   installs seaworthy's `pre-commit`, `commit-msg` and `pre-push` git hooks; existing hooks (husky,
   lefthook) are kept and still run first.
4. If they asked for different commands, edit `.seaworthy.json` before any session starts
   (`checks[].cmd`, `tiers`, `caps`, `autonomy`, `allowedTrailers`). It is protected during sessions.
5. Suggest committing `.seaworthy.json` so the whole team gets the same gates.
6. Mention that Claude Code adds a co-author trailer to commits by default; seaworthy refuses trailers
   the repository does not already use, so the developer may want to turn commit attribution off in
   their Claude Code settings.
7. Finish with: start a loop with `/seaworthy:ship <task>`, or `/seaworthy:ship` to finish existing work.
