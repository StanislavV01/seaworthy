# ship-loop MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the ship-loop core CLI, the Claude Code plugin and the Orca extension described in the design, hardened against an adversarial agent.

**Architecture:** A zero-dependency ESM JavaScript core (`plugins/ship-loop/core/`) does all the work: detection, checks, state, guards, Bash analysis, CI and reports. Claude Code hooks, git hooks and the Orca worker are thin adapters that call the core. One repository is both the Claude Code marketplace and the Orca plugin.

**Tech Stack:** Node ≥ 20, plain ESM JS with JSDoc types checked by `tsc --checkJs`, `node:test`, git, gh CLI. Orca adapter in TypeScript without a build step.

**Spec:** `docs/superpowers/specs/2026-11-26-ship-loop-design.md`

## Global Constraints

- Zero runtime dependencies in `plugins/ship-loop/`. Dev dependency allowed: `typescript` only.
- Node ≥ 20; `"type": "module"`; every core file starts with `// @ts-check`.
- All hooks are no-ops unless a session is active for this worktree and its `session_id` matches (spec 7.4).
- Hook semantics: block with exit 2 + stderr, or exit 0 + one JSON object on stdout. Never exit 1 to block.
- State at `$(git rev-parse --git-dir)/ship-loop/state.json`, `version: 1`, HMAC-SHA256 over the canonical JSON.
- Caps (defaults): fix attempts per check 3; same signature 2; review rounds 2; CI cycles 3; flaky reruns per sha 1; stop-gate blocks 5; check timeout 600 s; CI watch per call ≤ 540 s; total CI wait 30 min; run discovery wait 3 min; excerpt ≤ 8,000 chars.
- Tiers: `fast` = lint (+ typecheck); `commit` = lint, typecheck, test; `push` = commit + build.
- Never set git identity, never `--no-verify`, never add trailers absent from the last 20 commits or `allowedTrailers`.
- Commits in this repo: Conventional Commits, author `Stanislav <83041246+StanislavV01@users.noreply.github.com>`, no trailers.

## Review Focus

1. Bash commands that hide a git write (`sh -c`, `eval`, aliases, `$(…)`, `commit-tree`+`update-ref`): must be denied — Task 9 table.
2. A worktree whose `.git` is a file (linked worktree) or a repo with no commits: fingerprint, git-dir and state paths must still work — Task 5 tests.
3. Existing git hooks (husky, lefthook, custom `core.hooksPath`) must keep running after `init` — Task 12 tests.
4. No session active: every hook entry returns pass-through with exit 0 and no output — Task 11 test `noop when no session`.
5. `gh` missing or unauthenticated, or a fine-grained token that cannot `run watch`: CI step degrades to polling or a clear report, never a crash — Task 13 tests.

---

### Task 1: Repository skeleton and CLI router

**Files:**
- Create: `package.json` (root, private, devDependencies `typescript`, scripts `test`, `typecheck`)
- Create: `tsconfig.json` (`allowJs`, `checkJs`, `noEmit`, `strict`, include `plugins/ship-loop/core/**/*.js`, `test/**/*.js`)
- Create: `plugins/ship-loop/core/cli.js`, `plugins/ship-loop/bin/ship-loop` (shim: `#!/usr/bin/env node` importing `../core/cli.js`)
- Create: `.github/workflows/ci.yml` (Node 22: `npm install`, `npm run typecheck`, `npm test`)
- Create: `LICENSE` (MIT), `.gitignore`
- Test: `test/cli.test.js`

**Interfaces:**
- Produces: `main(argv: string[], io: {stdin, stdout, stderr, cwd: string, env: Record<string,string>}) => Promise<number>` (exit code) in `cli.js`; commands registered in a map `name → (args, io) => Promise<number>`.

- [ ] Step 1: tests `prints usage and exits 0 on --help`, `unknown command exits 2 with "unknown command"`.
- [ ] Step 2: run `npm test` → FAIL.
- [ ] Step 3: implement router; `bin/ship-loop` calls `process.exit(await main(process.argv.slice(2), …))`.
- [ ] Step 4: `npm test && npm run typecheck` → PASS.
- [ ] Step 5: commit `chore: repository skeleton and CLI router`.

### Task 2: Project detection (JS/TS)

**Files:** Create `core/detect.js`; Test `test/detect.test.js`; Fixtures `test/fixtures/{npm,pnpm,yarn,bun,bun-legacy,pm-field,no-scripts,placeholder-test}/package.json` (+ lockfiles).

**Interfaces:**
- Produces: `detectProject(root: string) => Promise<ProjectConfig>` where `ProjectConfig = { packageManager: 'npm'|'pnpm'|'yarn'|'bun', checks: {id: 'lint'|'typecheck'|'test'|'build', cmd: string}[], tiers: {fast: string[], commit: string[], push: string[]} }`.

- [ ] Step 1: tests — `packageManager field wins over lockfile` (`"packageManager":"pnpm@9.1.0"` + `package-lock.json` → pnpm); `lockfile order` (each fixture → its PM; `bun.lock` and `bun.lockb` → bun); `scripts map to checks` (`type-check` → id `typecheck`, cmd `pnpm run type-check`); `npm placeholder test ignored`; `tiers` (`fast:['lint','typecheck']`, `commit:['lint','typecheck','test']`, `push:[…commit,'build']`, missing checks omitted).
- [ ] Step 2: run → FAIL. Step 3: implement. Step 4: run → PASS.
- [ ] Step 5: commit `feat(core): detect package manager, scripts and tiers`.

### Task 3: Workflow reading (CI cross-check and PR need)

**Files:** Create `core/workflows.js`; Test `test/workflows.test.js`; Fixtures `test/fixtures/workflows/{push-main-and-pr,push-all,pr-only,none}/.github/workflows/ci.yml`.

**Interfaces:**
- Produces: `readWorkflows(root) => Promise<{file: string, onPush: string[]|'all'|null, onPullRequest: boolean, runSteps: string[]}[]>` (line-based, no YAML dependency); `ciRunsOnPush(workflows, branch: string) => boolean`; `crossCheck(config: ProjectConfig, workflows) => string[]` (warnings).

- [ ] Step 1: tests — defi-agent shape (`push: branches: [main]` + `pull_request`) → `ciRunsOnPush(…,'feat/x') === false`, `('main') === true`; `on: [push, pull_request]` → true for any branch; `run: npm run lint` step matched to check `lint`; CI step with no local check → warning text contains the command.
- [ ] Steps 2–4: FAIL → implement → PASS. Step 5: commit `feat(core): read workflow triggers and cross-check checks`.

### Task 4: Config file and `init`

**Files:** Create `core/config.js`, `core/commands/init.js`, `core/commands/detect.js`; Test `test/config.test.js`.

**Interfaces:**
- Consumes: `detectProject`, `readWorkflows`, `crossCheck`.
- Produces: `.ship-loop.json` schema `{ version: 1, packageManager, checks, tiers, caps: {...defaults}, autonomy: 'careful'|'normal'|'auto', allowedTrailers: string[] }`; `loadConfig(root) => Promise<Config|null>`; `saveConfig(root, cfg)`; `configHash(cfg) => string` (sha256 of canonical JSON).

- [ ] Step 1: tests — `init --yes` writes config with spec default caps and `autonomy: 'normal'`; `canonical JSON hash is key-order independent`; `invalid config rejected with field name`.
- [ ] Steps 2–4. Step 5: commit `feat(core): ship-loop.json config and init command`.

### Task 5: Git primitives and tree fingerprint

**Files:** Create `core/git.js`; Test `test/git.test.js` (creates temp repos with `git init`).

**Interfaces:**
- Produces: `git(cwd, args: string[]) => Promise<{code:number, stdout:string, stderr:string}>`; `gitDir(cwd)`; `headSha(cwd) => string|null`; `defaultBranch(cwd) => string` (origin HEAD, else `main`); `treeFingerprint(cwd) => Promise<string>` using a temp `GIT_INDEX_FILE`, `git add -A`, `git write-tree`; `recentCommitMessages(cwd, n)`.

- [ ] Step 1: tests — `fingerprint changes after edit and returns after revert`; `ignores .gitignored files`; `does not touch the real index` (`git diff --cached` unchanged); `works in a linked worktree` (`git worktree add`); `works in a repo with no commits`.
- [ ] Steps 2–4. Step 5: commit `feat(core): git primitives and tree fingerprint`.

### Task 6: State with integrity

**Files:** Create `core/state.js`, `core/integrity.js`; Test `test/state.test.js`.

**Interfaces:**
- Produces: `State` type per spec 7.4 (+ `config_hash`, `start_tree`, `base_sha`, `session_id`, `phase`, `counters`, `checks: {[tier]: {tree, ok, failed: string[], at}}`, `review`, `guard_events`, `commits`, `ci`); `loadState(cwd) => Promise<State|null>` (throws `TamperError` on bad HMAC); `saveState(cwd, state)`; `keyPath(env)` = `${CLAUDE_PLUGIN_DATA}/key` else `~/.config/ship-loop/key` (created 0600).

- [ ] Step 1: tests — `round trip`; `edited state fails verification with TamperError`; `missing key file is created once`; `state path is per worktree`.
- [ ] Steps 2–4. Step 5: commit `feat(core): signed per-worktree state`.

### Task 7: Check runner

**Files:** Create `core/checks.js`, `core/commands/check.js`; Test `test/checks.test.js`.

**Interfaces:**
- Consumes: `loadConfig`, `treeFingerprint`, `loadState/saveState`.
- Produces: `runTier(cwd, tier, {files?: string[], timeoutMs?: number}) => Promise<{tier, tree, ok, failed: string[], logs: Record<string,string>}>` (logs written to `…/ship-loop/runs/<ts>-<check>.log`); `isGreen(state, tier, tree) => boolean` (a passing `push` result also satisfies `commit` for the same tree).

- [ ] Step 1: tests — `records result bound to fingerprint`; `edit after green → isGreen false`; `timeout marks check failed with "timeout"`; `push green implies commit green`.
- [ ] Steps 2–4. Step 5: commit `feat(core): tiered check runner bound to tree`.

### Task 8: Diff-guard

**Files:** Create `core/guard.js`, `core/commands/guard.js`; Test `test/guard.test.js`.

**Interfaces:**
- Produces: `scanGuard(cwd, startTree: string) => Promise<GuardEvent[]>`, `GuardEvent = { id: string (stable hash of type+path+detail), type: 'test_deleted'|'test_case_removed'|'skip_added'|'suppression_added'|'config_changed', path, detail }`.

- [ ] Step 1: tests — one per spec 7.5 rule (delete `a.test.ts`; `it(` count 3→2; add `.skip`/`.only`/`xit`/`test.todo`; add `@ts-ignore`, `eslint-disable`, `biome-ignore`, `oxlint-disable`; change `vitest.config.ts`, `tsconfig.json` `strict`, `.github/workflows/ci.yml`, `package.json` `scripts`); `pre-existing changes at start are not flagged`; `ids stable across scans`.
- [ ] Steps 2–4. Step 5: commit `feat(core): diff-guard against session start tree`.

### Task 9: Bash command analyzer

**Files:** Create `core/bash-analyzer.js`; Test `test/bash-analyzer.test.js` (table-driven).

**Interfaces:**
- Produces: `analyzeCommand(cmd: string) => { gitWrites: {verb: string, argv: string[], canonical: boolean}[], protectedWrites: string[], humanOnly: string[], ambiguous: boolean }`. Protected paths: `.git/`, `.ship-loop.json`, `.github/workflows/`, the key path, the plugin dir (passed in via options).

- [ ] Step 1: table tests (≥ 25 rows), e.g. `git commit -m x` → canonical commit; `sh -c "git commit -m x"` → commit, not canonical; `eval "git push"`; `git -c alias.c=commit c -m x`; `git -C . commit`; `x=$(git commit-tree …) && git update-ref refs/heads/main $x`; `git config core.hooksPath /tmp`; `echo '{}' > .git/ship-loop/state.json` → protected write; `sed -i s/x/y/ .ship-loop.json`; `python -c "open('.ship-loop.json','w')"` → protected write (interpreter with inline code naming a protected path); `ship-loop approve g1` → humanOnly; `git status && npm test` → nothing; unterminated quote with `git push` inside → ambiguous.
- [ ] Steps 2–4. Step 5: commit `feat(core): bash analyzer for git writes and protected paths`.

### Task 10: Commit rules and trailers

**Files:** Create `core/commit-rules.js`; Test `test/commit-rules.test.js`.

**Interfaces:**
- Produces: `allowedTrailerKeys(cwd, cfg) => Promise<Set<string>>` (keys seen in last 20 commits ∪ `cfg.allowedTrailers`); `checkCommitArgs(argv: string[]) => string|null` (reason; rejects `--no-verify`, `-n`, `--author`, `-c user.*`, `--amend` without consent); `checkMessage(msg, allowed: Set) => string|null` (rejects unknown trailer keys, incl. `Co-Authored-By`).

- [ ] Step 1: tests — `Co-Authored-By: Claude` rejected on a repo without such trailers; allowed when in history; `-F msg.txt` content is checked (caller passes file content); `--no-verify` rejected.
- [ ] Steps 2–4. Step 5: commit `feat(core): commit argument and trailer rules`.

### Task 11: Claude Code hook dispatcher

**Files:** Create `core/hooks/{index,user-prompt-submit,pre-tool-use,post-tool-use,stop,subagent-stop,session-start}.js`, `core/commands/hook.js`; Test `test/hooks/*.test.js` with recorded input JSON in `test/hooks/fixtures/`.

**Interfaces:**
- Consumes: Tasks 5–10.
- Produces: `ship-loop hook <name>` reads stdin JSON, returns `{exitCode, stdout?, stderr?}`. Behaviors per spec 7.4, 7.6, 7.12: UserPromptSubmit claims session on `/ship-loop:ship` (stores `session_id`, `start_tree`, `base_sha`, `config_hash`); PreToolUse = protected paths (Edit/Write/MultiEdit/NotebookEdit and Bash via analyzer) → human-only → git writes (non-canonical deny; commit gate; push gate with `ask` in normal/careful); PostToolUse lints the edited file with the `lint` check scoped by `--files` when the script supports it, else skips; Stop gate with `stop_blocks` cap 5; SubagentStop requires JSON verdict from `ship-loop:reviewer`; SessionStart injects summary.

- [ ] Step 1: tests — `noop when no session` (every hook); `claims session only on /ship-loop:ship`; `commit denied when checks stale`; `commit denied with unresolved guard`; `commit allowed when green + review approved for same tree`; `request-approval answered with ask`; `approve/stop/waive from agent denied`; `push to default branch denied`; `force push denied, force-with-lease asks`; `stop blocked with next step text, allowed after 5 blocks and phase=escalated`; `reviewer without JSON verdict blocked`; `tampered state → escalated, all writes denied`.
- [ ] Steps 2–4. Step 5: commit `feat(core): claude code hook dispatcher`.

### Task 12: Git hooks backstop

**Files:** Create `core/git-hooks.js`, `core/commands/githook.js`; Test `test/git-hooks.test.js`.

**Interfaces:**
- Produces: `installGitHooks(cwd) => Promise<{installed: string[], chained: string[]}>` (writes `pre-commit`, `commit-msg`, `pre-push` into the effective hooks dir — `core.hooksPath` or `.git/hooks` — preserving an existing hook as `<name>.ship-loop-prev` and calling it first); `ship-loop githook <name> [args]` re-verifies gates when a session is active, else exits 0.

- [ ] Step 1: tests — `existing hook still runs`; `husky dir (.husky) respected via core.hooksPath`; `commit refused by git when gates red during session`; `passes outside session`; `trailer rejected in commit-msg`.
- [ ] Steps 2–4. Step 5: commit `feat(core): git hooks backstop`.

### Task 13: CI watcher, excerpts, caps

**Files:** Create `core/ci.js`, `core/redact.js`, `core/caps.js`, `core/commands/ci.js`; Test `test/ci.test.js` (gh stubbed via a fake `gh` script on PATH), `test/redact.test.js`, `test/caps.test.js`.

**Interfaces:**
- Produces: `findRun(cwd, sha, {waitMs}) => Promise<Run|null>`; `watchRun(cwd, id, {maxMs: 540000}) => Promise<'success'|'failure'|'pending'>` (uses `gh run watch --exit-status --compact -i 15`, falls back to polling `gh run view --json status,conclusion` when watch errors); `failureExcerpt(cwd, id) => Promise<{text, signature}>` (≤ 8,000 chars, redacted); `ensurePr(cwd, branch) => Promise<{url, created}>`; `redact(text) => string`; `nextAction(state, event) => {action: 'fix'|'rerun'|'escalate'|'continue', reason}` encoding all caps.

- [ ] Step 1: tests — fake gh: run appears after 2 polls; watch failure → poll fallback; excerpt keeps error lines + context, length ≤ 8000; redact `ghp_…`, `github_pat_…`, `AKIA…`, `sk-…`, `KEY=…`; caps: 4th fix attempt → escalate; A→B→A → escalate; first unseen test-only failure → rerun once; `gh` missing → report "gh not available".
- [ ] Steps 2–4. Step 5: commit `feat(core): ci watcher, redaction and loop caps`.

### Task 14: Status, status line and report

**Files:** Create `core/report.js`, `core/commands/{status,report,stop,approve,request-approval}.js`; Test `test/report.test.js`.

**Interfaces:**
- Produces: `statusJson(cwd) => Promise<{tracked: boolean, phase, checks: {[tier]: 'green'|'red'|'stale'|'none'}, guard: {open: number}, review, ci, updatedAt}>` (also used by Orca); `statusLine(cwd) => string` e.g. `ship-loop ▸ checks ✓✓✗· (test 2/3) · review — · CI —`; `renderReport(state) => {markdown, json}` — never claims success when phase ≠ `done`; `approve <id>`, `waive <id>`, `stop` record the human decision (the agent is kept away from them by the PreToolUse analyzer, Tasks 9 and 11, not by these commands); `request-approval <id>` is the agent's allowed command: the PreToolUse hook answers it with `permissionDecision: "ask"` and a reason quoting the guard item, and on success it records the approval.

- [ ] Step 1: tests — `untracked repo → tracked:false`; status line for the example state; `escalated report lists not-done items`; `approve records decision with reason`.
- [ ] Steps 2–4. Step 5: commit `feat(core): status, status line and report`.

### Task 15: Claude Code plugin packaging

**Files:** Create `.claude-plugin/marketplace.json`, `plugins/ship-loop/.claude-plugin/plugin.json`, `plugins/ship-loop/hooks/hooks.json`, `plugins/ship-loop/skills/{ship,init,status,stop}/SKILL.md` (+ `skills/ship/playbooks/{commits,ci-fix,report}.md`), `plugins/ship-loop/agents/reviewer.md`; Test `test/plugin-manifest.test.js`.

**Interfaces:**
- Consumes: `ship-loop hook <name>` for every hook entry: `node "${CLAUDE_PLUGIN_ROOT}/core/cli.js" hook <name>`; PreToolUse matcher `Edit|Write|MultiEdit|NotebookEdit|Bash`; PostToolUse `Edit|Write|MultiEdit`; SubagentStop `^ship-loop:reviewer$`; SessionStart `resume|compact`; UserPromptSubmit and Stop without matcher.
- `ship` skill: `disable-model-invocation: true`, `argument-hint: "[task] [--auto|--careful]"`, phases per spec 7.4/7.7, calls `ship-loop check`, `guard`, `ci …`, `report`; reviewer gets diff path + task, returns JSON verdict.

- [ ] Step 1: test parses all JSON manifests, asserts every hook command targets an existing `hook` subcommand and every skill has frontmatter `name` + `description`.
- [ ] Steps 2–4. Step 5: commit `feat(plugin): claude code plugin, skills and reviewer agent`.
- [ ] Step 6 (author, local): `claude plugin validate --strict plugins/ship-loop` and a `--plugin-dir` smoke run on a fixture repo.

### Task 16: Red-team suite

**Files:** Create `test/redteam/redteam.test.js`, `test/redteam/cases.js` (≥ 30 cases).

**Interfaces:**
- Consumes: hook dispatcher (Task 11) fed with synthetic PreToolUse/Stop events in a temp repo with an active session, plus the git hooks (Task 12) for direct `git` calls.

- [ ] Step 1: write cases (each `{name, setup, attempt, expect: 'denied'|'detected'}`), including all Task 9 rows, plus: replace lint check with `true` in `.ship-loop.json`; delete failing test then add `it.skip` stub; add fake `test` script; `git commit --no-verify`; `git -c core.hooksPath=/dev/null commit`; edit state then commit; trailer via `-F`; `git push --force`; `ship-loop stop` from agent; `ship-loop approve` from agent; write to key file.
- [ ] Step 2: run → failures show the gaps; Step 3: fix core until all pass; Step 4: PASS.
- [ ] Step 5: commit `test: red-team suite of gate bypass attempts`.

### Task 17: Orca extension

**Files:** Create `orca-plugin.json` (format 2, `execution: "trusted-worker"`, `main: "orca/worker.ts"`, panel `orca/panel.tsx`, status bar item `ship-score`, settings `autoAttachClaudePlugin` and `gateClaudeCommits` both default `false`, events `agent.status.changed`, hooks `agent.launch.before`, `agent.tool.before` with `onError: "deny"`, capabilities `workspace:read`, `agent:read`, `notifications:show`, `settings:own`, `engines.orca >=1.4.246`, `pluginApi: 1`), `orca/worker.ts`, `orca/panel.tsx`, `orca/protocol.ts`.

**Interfaces:**
- Consumes: `statusJson`, `runTier`, `analyzeCommand` + gate logic from `core` by relative import.
- Produces: panel request `ship.rows` → `{workspaceId, name, branch, agentState, status: StatusJson|null}[]`; `ship.check` → runs commit tier in one worktree.

- [ ] Step 1: worker — on `agent.status.changed` with `state === 'done'`: resolve via `workspace.list`, skip if `hostId` not `local`/null, folder workspace or no `.ship-loop.json`; debounce 10 s per worktree; run commit tier; on red `notifications.show({title: 'Done, but red', body: '<branch>: <failed checks>'})`; update status bar `ship ✓ green/tracked`.
- [ ] Step 2: panel — table of rows with "Run checks" button.
- [ ] Step 3: opt-in hooks honoring the two settings (no-op when off).
- [ ] Step 4 (author, local): `pnpm validate:plugin <path>` from an Orca checkout; `orca plugin dev` load; `orca plugin dev emit . agent.status.changed --data …` against a red fixture worktree → notification appears.
- [ ] Step 5: commit `feat(orca): done-but-red detector, ship score panel and status bar`.

### Task 18: README, dogfooding and release

**Files:** Create `README.md` (problem, demo GIF placeholder, install for Claude Code and Orca, threat model and "not a sandbox", commands, config, caps, red-team results table), `docs/dogfood.md` (checklist against DoD items).

- [ ] Step 1: write README and dogfood checklist.
- [ ] Step 2 (author): run DoD scenarios on `defi-agent`: small task to green CI + PR; seeded test deletion caught; seeded build-only failure caught before push; Orca notification on a red worktree.
- [ ] Step 3: tag `v0.1.0`; add GitHub topic `orca-plugin`.
- [ ] Step 4: commit `docs: readme and dogfooding checklist`.
