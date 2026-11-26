---
name: ship
description: Take a task (or the developer's existing uncommitted work) all the way to green CI through seaworthy's gates — checks, tamper guard, independent review, clean commits, push, CI watch and an honest report.
disable-model-invocation: true
argument-hint: "[task] [--auto | --careful]"
---

# /seaworthy:ship

!`node "${CLAUDE_PLUGIN_ROOT}/core/cli.js" claim --session "${CLAUDE_SESSION_ID}" -- $ARGUMENTS 2>&1 || true`

Current state:

!`node "${CLAUDE_PLUGIN_ROOT}/core/cli.js" status 2>&1 || true`

!`git status --short --branch 2>&1 | head -40 || true`

Task from the developer: $ARGUMENTS
(If it is empty, the task is: finish, verify and ship the uncommitted work already in this repository.)

## How this works

A seaworthy session is now active in this worktree. Hooks enforce it: `git commit` is refused unless
the commit checks are green **for the exact current code**, the `seaworthy:reviewer` agent approved
**that same code**, and nothing in the diff weakens tests or checks. `git push` additionally needs the
push checks (with build). You cannot switch this off, edit seaworthy's files, or approve your own
changes — only the developer can. Do not try; explain instead.

If the message above says the session could not start (no `.seaworthy.json`, tampered state), stop
and tell the developer what it says.

## The loop

0. **Branch.** If you are on the default branch, create one first:
   `git switch -c ship/<short-slug>`. Never push to the default branch.
1. **Plan.** Write a short plan (≤ 10 lines). In `--careful` mode show it and wait for the developer.
   If the superpowers plugin is installed, use its planning and test-driven-development skills.
2. **Implement** in small steps. Keep changes focused on the task.
3. **Check.** Run `seaworthy check --tier commit`. If red, read the log path it prints, fix the
   cause, run it again. Never "fix" a check by deleting or skipping tests, adding `@ts-ignore` /
   `eslint-disable`, or loosening config — the guard will flag it and the commit will be refused.
4. **Guard.** Run `seaworthy guard`. Revert anything flagged that was not truly intended. If a flagged
   change is genuinely right (for example a test for removed behaviour), run
   `seaworthy request-approval <id>`: the developer sees a prompt and decides. Explain why first.
5. **Review.** Get the base commit from `seaworthy state --json` (`base_sha`). Dispatch the
   `seaworthy:reviewer` agent and wait for it, giving it the task, the base sha and the list of
   changed files (`git status --short`). Fix every `high` and `medium` finding, then repeat steps 3–5
   (at most 2 review rounds). Any code change after a review needs a new review.
6. **Commit** following `playbooks/commits.md`: plain `git commit -m "type(scope): subject"`, grouped
   by concern, no trailers, no `--no-verify`, `--author`, `--amend`, wrappers, `-c` or `-C`.
7. **Push.** Run `seaworthy check --tier push`, then `git push -u origin <branch>`. In normal mode the
   developer confirms the push.
8. **CI.** Run `seaworthy ci watch` and act on its exit code:
   - `0` green (or no CI) → step 9.
   - `1` failed → follow `playbooks/ci-fix.md`, then back to step 3 (checks, review, commit, push, watch).
   - `3` still running → run `seaworthy ci watch` again.
   - `4` escalated, paused or `gh` unavailable → step 9 and tell the developer.
9. **Report.** Run `seaworthy report --final` and show the developer its markdown. Never claim the
   work is done when the report says it is not.

If you are stuck (the same failure keeps coming back, or a fix would need weakening tests or
changing CI), stop, run `seaworthy report`, and explain honestly what is left. That is a good outcome;
a fake "done" is not.
