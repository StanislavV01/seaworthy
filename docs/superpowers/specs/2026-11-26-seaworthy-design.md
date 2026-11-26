# seaworthy — Design

Status: draft for approval · 2026-11-26 · Author: Stanislav

## 1. Intent

Coding agents say "done" when the work is not done: tests fail, the build breaks in CI, or the
agent "fixed" a failing test by deleting or skipping it. The developer finds out later, after the
push, and cleans up by hand. In the session this project came from, three pushes in a row went red
in CI after the agent declared success (a viem multicall typing error, a declaration-emit error, a
wagmi barrel import that only failed in `next build`).

**seaworthy makes "done" mean done.** It is a set of deterministic gates around a coding agent: it
detects the project's own checks, runs them before commit and push, guards against test tampering,
gets an independent review, splits work into clean commits, pushes, watches CI and fixes failures
within a cap, then reports honestly what happened.

It is a **complement to superpowers, not a replacement**. superpowers teaches the agent *how* to
work (brainstorm, plan, TDD, debugging) and enforces that mostly through prompts. seaworthy
*verifies the result* and enforces it with hooks and code the model cannot talk its way around.

Why now, for the author: a portfolio project for AI-engineer roles that people talk about, and an
entry point into the Orca ecosystem (stablyai/orca, an IDE for parallel coding agents).

## 2. Goals

1. One command takes a task (or the developer's existing uncommitted work) to green CI:
   `/seaworthy:ship [task]`.
2. Gates are enforced by code (Claude Code hooks, Orca hooks), not by instructions.
3. "Green" is bound to exact content: any edit after a passing check or approved review voids it.
4. Test tampering (deleted tests, new skips, `@ts-ignore`, weakened lint/test/CI config) never
   lands without the developer's explicit approval.
5. The loop always terminates, with its own counters and caps, and reports honestly when it gives
   up.
6. Commits are made as the developer: their git identity, no added co-author trailers, repo's
   commit style.
7. The same core powers an Orca extension that catches any agent (Claude Code, Codex, Gemini…)
   claiming "done" on a red worktree and ranks worktrees by readiness.

## 3. Non-goals (MVP)

- Python, Go, Makefile-only and monorepo "affected" detection (v0.2).
- Non-GitHub CI (GitLab, CircleCI).
- Cloud sessions (claude.ai/code) and hosted CI-fix bots (`claude-code-action` companion is later).
- Benchmark / eval harness (v0.3; the design records the metrics it will need).
- Remote Orca hosts (SSH, WSL, runtime) and Windows as a tested platform. Code must not be
  POSIX-only by accident, but MVP is tested on macOS and Linux.
- Replacing superpowers' planning, TDD or debugging skills.

## 4. Anti-goals (a failure even if it "works")

- Changing Claude Code behavior when no seaworthy session is active. Hooks are no-ops then.
- A loop that burns money or time silently. Every cap is visible; the report shows cost and time.
- Rewriting history or force-pushing without consent. Never `--no-verify`.
- Prompt fatigue: the default mode stops only where a human decision is genuinely needed.
- Reaching green by weakening tests, lint or CI config.
- Committing as anyone but the developer, or adding attribution they did not configure.

## 5. Constraints (verified against docs, 2026-11)

Claude Code (code.claude.com docs):
- Plugin components are namespaced: commands are `/seaworthy:<skill>`.
- Hook exit code 2 blocks and feeds stderr to the model; exit 1 does **not** block. PreToolUse
  decides via `hookSpecificOutput.permissionDecision`. Stop/SubagentStop block with
  `{"decision":"block","reason":…}`; `reason` becomes the next instruction.
- The built-in Stop-continuation cap (8) resets on every tool call → seaworthy keeps its own
  counter.
- Plugin agents ignore `hooks`/`permissionMode` → all gates live in `hooks/hooks.json`.
- `${CLAUDE_PLUGIN_ROOT}` is not visible to Bash-tool commands; a plugin `bin/` dir is on PATH.
- Command hook timeout 600 s; hook output capped at 10,000 chars.
- `allowed-tools` in a skill lasts one turn only.

Orca (stablyai/orca `docs/reference/plugin-*.md`, host API 1.10, plugins in Alpha):
- Repository root holds `orca-plugin.json` (manifest format 2); listed via GitHub topic
  `orca-plugin` + `vX.Y.Z` tag; validated by `pnpm validate:plugin`.
- `trusted-worker` profile: `main` runs in a Node process as the user (can run `git`, `node`);
  user approves on install. Worker may be `.ts` with no build step (`engines.orca >=1.4.246`).
- Available: `workspace.list` (paths, `hostId`), `agents.list`, event `agent.status.changed`
  (`state: working|blocked|waiting|done`, `mainAgent.outcome`), `notifications.show`,
  `statusBar.update`, panels with `plugin.request` to the worker, `settings:own`.
- Hooks: `agent.tool.before` (Claude Code waits; `{deny}` refuses the call; other agents only
  report), `agent.launch.before` (may change `command`/`env`). Handlers over 2 s count as pass
  unless `onError: "deny"`.
- Orca repo rules: cross-platform, remote hosts, folder (non-git) workspaces are first-class.

Code:
- Zero runtime dependencies. Plugins install from git with no build step, so the core is plain
  ESM JavaScript with JSDoc types, checked by `tsc --checkJs`. Node ≥ 20.
- Requires `git` and, for CI features, `gh` authenticated with a classic token or `gh auth login`
  (fine-grained PATs cannot `gh run watch` → polling fallback).

## 6. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| A | Claude Code plugin only, logic in plugin scripts | Fastest MVP; Orca/Codex support needs a rewrite later |
| **B** | **Core CLI + thin adapters (Claude Code plugin, Orca extension)** | ~1 day more up front; one core reused by Orca, later Codex, git hooks, CI, eval |
| C | Git hooks first (pre-commit/pre-push) | Agent-agnostic, but no channel to make the agent fix things; `--no-verify` bypasses it |

**Chosen: B**, because the Orca extension must read and produce seaworthy state without Claude
Code. Decided in conversation on 2026-11-26.

## 7. Decided design

### 7.1 Repository layout (one repo serves both ecosystems)

```
seaworthy/                         repo root = Claude Code marketplace + Orca plugin
├── .claude-plugin/marketplace.json  → plugins: [{ name: "seaworthy", source: "./plugins/seaworthy" }]
├── orca-plugin.json               Orca manifest; main: orca/worker.ts; panel: orca/panel.tsx
├── orca/                          Orca adapter (TS, no build step), imports ../plugins/seaworthy/core
├── plugins/seaworthy/             the Claude Code plugin (only this dir is installed by Claude Code)
│   ├── .claude-plugin/plugin.json
│   ├── core/                      zero-dep ESM JS: the whole engine + CLI entry core/cli.js
│   ├── bin/seaworthy              shim → node ../core/cli.js (on PATH for Bash tool)
│   ├── skills/{ship,init,status,stop}/SKILL.md
│   ├── agents/reviewer.md
│   └── hooks/hooks.json           every hook = `node "${CLAUDE_PLUGIN_ROOT}/core/cli.js" hook <name>`
├── test/                          node:test unit tests + fixture repos
└── docs/superpowers/{specs,plans}/
```

The core lives inside the plugin directory because Claude Code installs only that directory; the
Orca adapter reaches it by relative import, since Orca serves the whole repo.

### 7.2 Core CLI (`seaworthy`)

All commands accept `--json`; all read/write state for the current worktree.

| Command | Does |
|---|---|
| `init [--yes]` | Detects checks, cross-checks with `.github/workflows/*`, shows the result, writes `.seaworthy.json` |
| `detect` | Prints detected config without writing |
| `check [--tier fast\|commit\|push] [--files …]` | Runs checks for the tier, records result bound to the tree fingerprint |
| `guard` | Diff-guard of working tree vs session base; prints flagged items |
| `start --task … / stop / state` | Session lifecycle and raw state |
| `hook <name>` | Entry point for every Claude Code hook (reads stdin JSON, answers per hook semantics) |
| `ci find\|watch\|excerpt --sha <sha>` | Find the run for a commit, wait for it, produce a bounded, redacted failure excerpt |
| `status` | Summary for humans / `--json` for Orca and the status line |
| `report` | Final report (markdown + JSON) |

### 7.3 Check detection (MVP: JS/TS)

- Package manager: `packageManager` field → lockfile (`pnpm-lock.yaml`, `yarn.lock`, `bun.lock`/
  `bun.lockb`, `package-lock.json`) → npm.
- Scripts from `package.json`: `lint`, `typecheck` (or `type-check`, `tsc`), `test`, `build`.
  A `test` script that is the npm placeholder (`echo "Error: no test specified" && exit 1`) is ignored.
- Cross-check: parse `run:` steps in `.github/workflows/*.yml` with a line-based scan (no YAML
  dependency); warn about CI steps with no local equivalent and vice versa. `init` shows warnings;
  it never silently adds commands.
- Tiers: `fast` = lint (+ typecheck if under budget); `commit` = lint, typecheck, test;
  `push` = commit + build. *(My call: build only gates push, because it is the slowest and the
  defi-agent wagmi failure shows it must run before push.)*
- `.seaworthy.json` (committed, shared by the team) is the source of truth after `init`; the
  developer can edit commands and tiers.

### 7.4 State and the tree fingerprint

- State file: `$(git rev-parse --git-dir)/seaworthy/state.json` — per worktree, never committed.
  Logs and excerpts in `…/seaworthy/runs/`.
- Fingerprint: `GIT_INDEX_FILE=<tmp> git add -A && git write-tree` (respects `.gitignore`, does not
  touch the real index).
- State records: session id, phase, task, branch, base sha, last check result per tier with its
  fingerprint, review verdict with its fingerprint, guard events and resolutions, commits, CI runs
  with failure signatures, counters, timestamps, cost if known. Schema versioned (`version: 1`).
- Phases: `implement → checks → review → commit → push → ci → report → done`, plus `waiting_ci`,
  `escalated` and `stopped`.
- **Session binding** *(my call)*: a `UserPromptSubmit` hook that sees a prompt starting with
  `/seaworthy:ship` creates or claims the session and stores Claude Code's `session_id`. Nothing
  else starts a session: there is no `seaworthy start` for the agent to call. A launch from Orca
  with that prompt goes through the same path. All other hooks act only when `session_id` matches.
- **Session start snapshot** *(my call)*: at start the state stores `base_sha` (HEAD) and
  `start_tree` (fingerprint of the working tree, uncommitted work included). Diff-guard compares
  against `start_tree`, so only changes made during the session are guarded; the developer's
  pre-existing changes are listed in the report as "pre-existing, not guarded".

### 7.5 Diff-guard

Compared against the session's `start_tree` (see 7.4). Flags:
- deleted or renamed-away test files (`*.test.*`, `*.spec.*`, `__tests__/`, `test/`, `tests/`);
- removed test cases (`it(`/`test(` count decreased in a file);
- added `.skip`, `.only`, `xit`, `xdescribe`, `test.todo`;
- added `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `// biome-ignore`, `oxlint-disable`;
- changes to lint/test/type/CI config (`eslint.config.*`, `.eslintrc*`, `tsconfig*.json` strictness
  flags, `vitest|jest|playwright.config.*`, `.github/workflows/*`, `package.json` scripts).

A flagged item blocks commit until resolved: the agent reverts it, or the developer approves it
(recorded in state with a reason). In `auto` mode guard events still stop the loop.

### 7.6 Claude Code adapter

Hooks (all no-ops unless a session is active for this worktree and `session_id` matches):

| Event | Matcher / if | Behavior |
|---|---|---|
| PostToolUse | `Edit\|Write\|MultiEdit` | Lint the edited file only (fast); on error `decision:block` + short reason. Mark state dirty |
| PreToolUse | `Bash`, `if: Bash(git commit *)` | Deny unless: `commit`-tier checks green for current fingerprint, review approved for current fingerprint, no unresolved guard events, no `--no-verify`, no `--author`/`-c user.*`, no trailer the developer didn't configure |
| PreToolUse | `Bash`, `if: Bash(git push *)` | Deny `--force` (allow `--force-with-lease` only with recorded consent), deny push to default branch, require `push`-tier green; in `normal`/`careful` mode return `ask` so the developer confirms |
| Stop | — | If phase not terminal: block with the concrete next step ("typecheck red: …", "review missing", "CI run #… pending"); own counter `stop_blocks` (cap 5) then allow stop and set `escalated` |
| SubagentStop | `^seaworthy:reviewer$` | Require JSON verdict `{verdict, findings[]}`; store it with the fingerprint it reviewed |
| SessionStart | `resume\|compact` | Inject a compact state summary so the loop survives compaction/resume |

Skills: `ship` (orchestrates phases; `disable-model-invocation: true`; long playbooks in separate
files loaded on demand), `init`, `status`, `stop` (escape hatch: ends session, gates off).

Reviewer agent: read-only tools (Read, Grep, Glob, Bash for `git diff`), receives the diff path and
task, returns JSON verdict `approve | changes_requested` with findings `{severity, file, line,
note}`. Max 2 review rounds; remaining findings go to the report as open.

### 7.7 Commits, push, CI

- Commits: group changes by concern into Conventional Commits unless the repo history uses another
  style (detect from last 20 subjects). Stage by explicit paths; `git apply --cached` for partial
  files. Never set identity; refuse if `user.email` is unset.
- Trailers: the commit gate denies any trailer (`Co-Authored-By`, `Generated-by`, `Signed-off-by`,
  …) unless it appears in the repo's last 20 commits or in `.seaworthy.json` `allowedTrailers`.
  So Claude Code's default `Co-Authored-By: Claude` is refused on a stock install and the agent
  re-commits without it; `init` also tells the developer how to turn off Claude Code attribution.
  *(Decided by the author: commits must look like the developer's own.)*
- Push policy: on a feature branch push to it; on the default branch create
  `ship/<slug>` and push it. *(My call.)*
- PR policy *(my call)*: `init` reads the `on:` triggers of each workflow. If the pushed branch is
  not covered by a `push` trigger (e.g. `push: branches: [main]` plus `pull_request`, as in
  defi-agent), seaworthy makes sure a PR exists (`gh pr create --draft` if none) so CI runs, and
  watches the PR's checks. If no workflow would run at all, the report says "no CI configured",
  which is not a failure.
- CI: `gh run list --commit <sha> --json databaseId,status,conclusion,workflowName,url` (wait up to
  3 min for the run to appear) → `gh run watch <id> --exit-status --compact -i 15`, falling back to
  polling `gh run view <id> --json status,conclusion` every 15 s → on failure
  `gh run view <id> --log-failed` → excerpt: error lines with context + tail of each failed step,
  ≤ 8,000 chars, secrets redacted (known token patterns, `KEY=…`-style assignments, high-entropy
  strings) → agent fixes → local checks → commit → push → next cycle.
- Waiting for CI *(my call)*: the turn stays alive. The agent calls `seaworthy ci watch`, which
  blocks for at most 9 minutes per call (under the 10-minute Bash limit) and costs no tokens while
  waiting; the Stop gate in phase `ci` tells the agent to call it again. After 30 minutes of total
  CI wait the session moves to `waiting_ci`, the Stop gate allows the turn to end, and the next
  `/seaworthy:ship` resumes from the CI step.
- Flaky handling: on a failure whose signature was not seen before and whose job is test-only,
  `gh run rerun <id> --failed` once per sha; a pass is reported as flaky, not "fixed".

### 7.8 Caps (defaults, in `.seaworthy.json`)

| Counter | Default |
|---|---|
| Fix attempts per check | 3 |
| Same failure signature repeated / A→B→A oscillation | 2 → escalate early |
| Review rounds | 2 |
| CI cycles (fix → push) | 3 |
| Flaky reruns per sha | 1 |
| Stop-gate blocks | 5 |
| Check command timeout | 600 s |

Values are my call; there is no published guidance. They will be calibrated by the eval in v0.3.

### 7.9 Autonomy modes

`careful` (stop at plan, commit split, push), **`normal` (default; stop before push and on guard
events)**, `auto` (stop only on guard events and escalation). Flag: `/seaworthy:ship --auto …`.

### 7.10 User experience

- `/seaworthy:ship <task>` — full loop. `/seaworthy:ship` with no task — finish the developer's
  existing uncommitted work.
- Status line command `seaworthy status --line`, e.g.
  `seaworthy ▸ checks ✓✓✗· (test 2/3) · review — · CI —`.
- Failures shown as one line in chat; full logs in `runs/`.
- Final report: task, commits, checks per tier, review verdict and open findings, guard events and
  resolutions, CI result with link and cycles used, flaky tests, wall time, cost when available,
  and "not done" items. Never claims success the state does not support.

### 7.11 Orca extension (same repo, `orca-plugin.json`, `trusted-worker`)

1. **Done-but-red detector.** On `agent.status.changed` with `state: done`, resolve the worktree
   via `workspace.list` (`workspaceListId`); if `hostId` is `local` and the path is a git worktree
   with `.seaworthy.json`, run `seaworthy check --tier commit --json` in it (one at a time per
   worktree, debounced 10 s). If red: `notifications.show` ("Agent in `feat-x` says done — test
   failing"). Works for every agent Orca runs.
2. **Ship Score panel.** One row per worktree: agent and state, checks per tier, guard events,
   review verdict, CI, last updated. Data from `seaworthy status --json`; "Run checks" button per row.
3. **Status bar item:** `ship ✓ 2/3` (green worktrees / worktrees with seaworthy).
4. **Opt-in, off by default** (settings): auto-attach the Claude Code plugin to Claude Code launches
   via `agent.launch.before` (append `--plugin-dir <this repo>/plugins/seaworthy`); gate
   `git commit`/`git push` for Claude Code via `agent.tool.before` using the same rules as 7.6.
   *(My call: off by default so the first install never blocks anyone's agents.)*
5. Folder workspaces, remote hosts and worktrees without `.seaworthy.json` are shown as
   "not tracked", never errors.

## 8. Testing the product

- Unit tests (`node:test`) for detection, fingerprint, guard rules, failure signatures, redaction,
  excerpting, cap logic, hook decisions (feed recorded hook JSON, assert output and exit code).
- Fixture repos under `test/fixtures/` (npm, pnpm, yarn, bun; with/without CI workflow; seeded
  guard violations).
- CI: `tsc --checkJs`, tests, `claude plugin validate --strict` if available in CI, Orca
  `validate:plugin` when feasible.
- Dogfooding on `defi-mcp` and `defi-agent` by the author (live Claude Code and Orca are only on
  the author's machine).

## 9. Definition of done (MVP)

- On `defi-agent`, `/seaworthy:ship <small task>` reaches green CI and a PR without manual git.
- A seeded "delete the failing test" scenario is caught by diff-guard and never committed.
- A seeded build-only failure (like the wagmi import) is caught before push.
- In Orca, an agent finishing on a red worktree triggers a notification, and the panel shows all
  worktrees with correct status.
- Published: Claude Code marketplace install works from GitHub; Orca directory lists the plugin.

## 10. Left to the builder

- Internal module boundaries inside `core/`, naming, error message wording.
- Exact secret-redaction pattern list (start from GitHub's token formats).
- Panel visual design within Orca's declarative components and theme tokens.
- How the `ship` skill text is split into playbooks.
- Whether `init` also offers a bare `/ship` project skill.

## 11. Later

v0.2: Python/Go/Make, monorepo affected, `gh pr checks`, report in PR body. v0.3: eval harness
(`claude -p --bare --plugin-dir … --output-format json`, metrics: green-at-first-push, guard
catches, CI cycles, `total_cost_usd`), compared with and without seaworthy and with superpowers;
possibly on superpowers-evals/Quorum. Later: `claude-code-action` companion, `asyncRewake` CI wait,
Codex adapter, public "does your agent lie about done" benchmark.
