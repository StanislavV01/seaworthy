<div align="center">

# ⚓ seaworthy

**Your coding agent says "done". seaworthy checks.**

Deterministic quality gates for coding agents: your project's own checks before every commit and
push, a guard against test tampering, an independent review, clean commits and CI watched until it
is green — enforced by hooks and git hooks the agent cannot talk its way around.

A **Claude Code plugin** and an **[Orca](https://github.com/stablyai/orca) extension**, sharing one
zero-dependency core.

<img src="docs/demo.svg" alt="seaworthy refusing an agent's shortcuts on a real C++ repo" width="860">

![tests](https://img.shields.io/badge/tests-357_passing-3fb950?style=flat)
![red-team](https://img.shields.io/badge/red--team-100_bypasses_blocked-6366F1?style=flat)
![deps](https://img.shields.io/badge/runtime_deps-0-blue?style=flat)
![License](https://img.shields.io/badge/license-MIT-blue?style=flat)

</div>

---

## The problem

Agents end their turn with "done!" while the build is broken, CI is red, or a failing test was
quietly skipped. Research measures it: in *EvilGenie* (arXiv 2511.21654), coding agents hard-coded
test cases or wrote heuristic "make the test pass" solutions in a meaningful share of tasks, and
some deleted test files outright. Prompting "please run the tests" does not fix this — a prompt is
a suggestion. **seaworthy turns it into a gate.**

## What you get

```
/seaworthy:ship add a dark-mode toggle
```

| Step | Enforced by |
|---|---|
| Your own `lint`, `typecheck`, `test` (and `build` before push) must be green **for the exact working tree**, and only that exact `HEAD` can be pushed | PreToolUse hook + git `pre-commit` / `pre-push` |
| Deleted tests, `.skip`/`.only`, `@ts-ignore`/`eslint-disable`, loosened `tsconfig`, edited test/CI config → blocked until **you** approve | diff-guard |
| A separate reviewer agent (fresh context, given the real base and file list by a hook) must approve **the same code**, unchanged while it reviewed | SubagentStart / SubagentStop hooks |
| Commits look like yours: your git identity, no `Co-Authored-By` or other trailers the repo does not use | PreToolUse + git `commit-msg` |
| No push to the default branch, no force push, no pushing code other than what was checked | PreToolUse + git `pre-push` |
| CI watched with `gh`, failures excerpted (secrets redacted), fixed and re-pushed within caps | `seaworthy ci watch` |
| The agent cannot end its turn while work is open — and cannot loop forever | Stop hook with its own counter |
| A report that never claims success the state does not support | `seaworthy report --final` |

Anything you do outside a session is untouched: every hook is a no-op until you type
`/seaworthy:ship`.

## Works with superpowers

[superpowers](https://github.com/obra/superpowers) teaches the agent *how* to work — brainstorming,
plans, TDD, debugging — mostly through skills. seaworthy *verifies the result* with code. They
install side by side; the `ship` skill uses superpowers' planning and TDD when they are present.

## Install

**Claude Code** (from GitHub):

```
/plugin marketplace add StanislavV01/seaworthy
/plugin install seaworthy@seaworthy
```

or, from a local clone: `claude --plugin-dir /path/to/seaworthy/plugins/seaworthy`

Then, in your repository:

```
/seaworthy:init          # detect checks, compare with CI, write .seaworthy.json, install git hooks
/seaworthy:ship <task>   # run the loop (or no task: finish your existing uncommitted work)
/seaworthy:status        # where the loop is
/seaworthy:stop          # end the session, gates off
```

Requirements: Node ≥ 20, git, and the [GitHub CLI](https://cli.github.com) (`gh auth login`) for
CI. JS/TS projects (npm, pnpm, yarn, bun) in v0.1.

**Orca**: install from the plugin directory (search "seaworthy"), or from a folder with
`orca plugin dev /path/to/seaworthy`. You get:

- **Done-but-red detector** — when *any* agent in Orca (Claude Code, Codex, Gemini, …) reports
  *done*, seaworthy runs that worktree's commit checks and notifies you if they fail.
- **Ship Score panel** — every worktree with checks, guard, review, CI and agent state: which
  agent's work is actually ready to merge.
- **Status bar** — `ship 2/3`.
- Opt-in: attach the Claude Code plugin to every Claude agent Orca launches; gate Claude's
  `git commit`/`git push` inside Orca with the same rules.

## How it works

```mermaid
flowchart TB
    Dev([Developer]) -->|/seaworthy:ship| CC[Claude Code plugin<br/>skills · hooks · reviewer agent]
    Dev --> Orca[Orca extension<br/>detector · Ship Score · status bar]
    CC --> Core[seaworthy core CLI<br/>checks · diff-guard · bash analyzer · signed state · CI]
    Orca --> Core
    Core --> Git[git hooks backstop<br/>pre-commit · commit-msg · pre-push · reference-transaction]
    Core --> GH[GitHub Actions via gh<br/>watch · excerpt · rerun flaky once]
```

- **Bound to content, not to time.** "Checks green" and "review approved" are recorded against a
  fingerprint of the whole working tree (`git write-tree` on a throwaway index). Change one byte
  afterwards and both are void.
- **Signed state.** The session state lives in `.git/seaworthy/state.json`, HMAC-signed with a
  per-machine key outside the repo, plus an out-of-repo marker. Editing it by hand, replaying an old
  copy or deleting it freezes every git write until you run `seaworthy stop`. The agent's Bash cannot
  read the key, seaworthy's code or the core copy git hooks run.
- **A shell analyzer, not a regex.** Every Bash command is tokenized (quotes, `$(…)`, backticks,
  here-docs, `sh -c`, `eval`, `xargs`, `find -exec`, aliases, `git -c`/`-C`, `GIT_*` and
  `NODE_OPTIONS` environment, ANSI-C strings, `trap`, `script -c`, `env -S`, `npm exec -c`) so
  `sh -c "git commit"` is seen for what it is. Git subcommands are allow-listed: anything that is not
  known to be safe (`send-pack`, `fast-import`, a plugin's subcommand) counts as a write. What it
  cannot read with confidence — shell functions, code piped into a shell, inline interpreter code
  that spawns processes or decodes code, `awk system()`, `sed e`, `tar --checkpoint-action` — it
  refuses.
- **No scripts written during the session.** The agent may run project files and installed tools,
  but not a script (or `package.json` script) it created or changed during the session — that closes
  "write a helper that does the forbidden thing".
- **A git-level backstop.** If a commit or push reaches git some other way during a session, git's
  own hooks re-check the same gates. A `reference-transaction` hook covers plumbing too: no branch or
  tag can move to a new commit while the commit gates are red, whether the commit came from
  `git commit`, `commit-tree` + `update-ref`, or a test file that shells out.

## Threat model (honest version)

seaworthy treats the agent **as an adversary inside the session**: it may try to edit the state,
swap a check for `true`, approve its own guard events, commit through wrappers, or delete the test
that fails. Each of those is blocked or detected — see the red-team suite below.

It is **not a sandbox**, and here is exactly where it stops:

- seaworthy sees what goes through Claude Code's tools. A program running as you outside that path
  (another tool, an MCP server, a process started earlier) can read the key and bypass the git hooks
  with plumbing such as `git commit --no-verify`. With your OS permissions, enough determination
  always wins locally.
- The commit gate checks the whole working tree, so an intermediate commit of a partial stage is not
  checked on its own; the pushed `HEAD` always is.
- A program the agent is allowed to run (a test file under `npm test`, a build script) is not read
  by the analyzer. Local branches are still protected by the `reference-transaction` hook, but such a
  program could send an existing object to the remote with `git send-pack`, which runs no client-side
  hook. That is what CI and branch protection are for.
- **CI is the ground truth.** seaworthy watches GitHub's result, which the agent cannot fake, and
  protects the workflow files from edits. Pair it with branch protection and required checks.

For real isolation, run agents in a container or an Orca VM recipe. Do not run sessions with
permission prompts disabled: approvals of guard events happen at Claude Code's permission prompt.

## Red-team results

`test/redteam/` runs 100 bypass attempts against a session whose code is red — the original 57, 24
found by an independent review and 19 found by [seaworthy-bench](bench/)'s execution fuzzer — and
21 everyday commands that must keep working. All attempts are blocked or detected (CI runs them on
every push):

| Category | Attempts | Examples |
|---|---|---|
| Git writes around the gates | 22 | a plain commit while red, `sh -c`, `eval`, `xargs`, `find -exec`, background `&`, `$GIT`, `$'\x67it'`, here-doc into `sh`, pipe into `bash`, `node -e` shelling out, `git -c alias…`, `-C`/`--git-dir`, `commit-tree`+`update-ref`, rebase / reset / cherry-pick, `--no-verify`, `--author`, `--amend` |
| Gate tampering | 19 | edit / copy / `tee` / `dd` / delete the state, swap a check in `.seaworthy.json` (sed, python), move the config, `rm -rf .`, delete git hooks, `core.hooksPath` (config and `-c`), change identity, self-approve, waive, stop or re-claim the session, read-and-delete the key |
| Protected files via tools | 4 | Write/Edit `.seaworthy.json`, git hooks, CI workflow, state |
| Around Claude Code entirely | 3 | commit / push from a script, trailer smuggled via `-F` |
| Test & check weakening | 6 | delete the failing test, `it.skip` stub, remove a case, `@ts-nocheck`, fake `test` script, `strict: false` |
| State forgery | 3 | forge green, replay an older signed state, delete the state |
| Found by seaworthy-bench | 19 | plain `git send-pack` to origin, plumbing commits hidden in shell functions, `. file`, `python -c` + base64, `awk system()`, `sed e`, `tar --checkpoint-action`, `npm exec -c`, `base64 \| sh`, `rev \| sh`, `make -f`, `script -c`, `trap EXIT`, `env -S`, `watch`, `node -e` with split quotes, `fetch` into a local branch; a plumbing commit from an unreadable script and from a program that shells out (refused by the `reference-transaction` hook) |
| Found in review | 24 | git aliases via `GIT_CONFIG_*`, `GIT_AUTHOR_NAME`, `export GIT_DIR`, `PATH`/`NODE_OPTIONS` shadowing the checks, running seaworthy's core copy or a copy of it, scripts written outside or inside the repo (incl. in the same command), `npm run` of a new script, symlinks and case tricks into `.git`, abbreviated `--auth`/`--no-veri`, `push --no-verify` to `heads/main`, `--force-with-lease`, pushing a stash commit, `git config set`/`--unset`, two approvals behind one prompt, reading the key, another Claude session in the same worktree |

## Configuration — `.seaworthy.json`

Written by `/seaworthy:init`, meant to be committed:

```json
{
  "version": 1,
  "packageManager": "pnpm",
  "checks": [
    { "id": "lint", "cmd": "pnpm run lint", "script": "lint", "perFile": "pnpm exec eslint {files}" },
    { "id": "typecheck", "cmd": "pnpm run typecheck", "script": "typecheck" },
    { "id": "test", "cmd": "pnpm run test", "script": "test" },
    { "id": "build", "cmd": "pnpm run build", "script": "build" }
  ],
  "tiers": { "fast": ["lint", "typecheck"], "commit": ["lint", "typecheck", "test"], "push": ["lint", "typecheck", "test", "build"] },
  "caps": { "fixAttemptsPerCheck": 3, "sameSignature": 2, "reviewRounds": 2, "ciCycles": 3, "flakyRerunsPerSha": 1, "stopBlocks": 5, "checkTimeoutSec": 600, "ciWatchSec": 540, "ciTotalWaitMin": 30, "runDiscoverySec": 180, "excerptChars": 8000 },
  "autonomy": "normal",
  "allowedTrailers": []
}
```

- `autonomy`: `careful` (confirm commits and pushes), `normal` (confirm pushes), `auto`. Per run:
  `/seaworthy:ship --careful …`.
- `allowedTrailers`: trailer keys your team uses (`Signed-off-by`, …). Keys already in your last 20
  commits are allowed automatically.
- Caps are starting values chosen by hand; there is no published guidance yet. Calibrating them is
  on the roadmap.

### Status line

Add to Claude Code's `settings.json` (adjust the path):

```json
{ "statusLine": { "type": "command", "command": "node /path/to/seaworthy/plugins/seaworthy/core/cli.js status --line" } }
```

→ `seaworthy ▸ checks ✓✓✗ (test 2/3) · review — · CI —`

## CLI

| Command | |
|---|---|
| `seaworthy init [--yes] [--force]` | detect checks, cross-check CI, write config, install git hooks |
| `seaworthy check --tier fast\|commit\|push` | run a tier; result bound to the current code |
| `seaworthy guard` | list guard events since the session started |
| `seaworthy ci watch` / `ci excerpt` | wait for CI on HEAD (opens a draft PR if CI only runs on PRs) / show the redacted failure |
| `seaworthy status [--json\|--line]` | status for humans, Orca and status bars |
| `seaworthy report [--final]` | the report; `--final` marks the session done only if everything is green |
| `seaworthy approve <id>` / `waive <id>` / `stop` / `allow-force-push` | **developer only** — refused when the agent runs them |

## Benchmark

[`bench/`](bench/) measures the gates instead of asserting them: calibrated scripted agents
(honest, sloppy, cheating, persistent) through three arms — no gate, the common "pre-commit tests +
block `--no-verify`" setup, and seaworthy — graded by a hidden oracle on what reached `origin`; an
execution fuzzer (1,056 bypass variants, each run for real); and a live A/B harness for Claude Code.

| seaworthy arm, reviewer simulated as always approving | |
|---|---|
| Structural cheats shipped (delete / skip tests, edit the test script, disable the gate …), incl. an agent trying 9 bypasses | **0 / 75** (pre-commit baseline: 69 / 75) |
| Sloppy work (build-only failure, debug log, post-review tweak) ending good | **6 / 6** (baseline: 2 / 6) |
| Fuzzer variants that moved a ref with red code | **0 / 980** (v0.1.0: 229) |
| Everyday commands refused | **0 / 40** |
| Semantic cheats (hard-coding, rewritten expectations) — the reviewer's job | 10 / 11 shipped with a fooled reviewer |

Full tables: [bench/RESULTS.md](bench/RESULTS.md). What the benchmark found in v0.1.0 and how it was
fixed: [bench/FINDINGS.md](bench/FINDINGS.md). Run it: `node bench/run.js` (offline) and
`node bench/live/run.js --n 5` (Claude Code, costs tokens).

## Development

```bash
npm install
npm test           # 357 tests: unit, hooks, git hooks, CI (fake gh), Orca worker (fake Orca), red-team
npm run typecheck  # tsc --checkJs over the JS core
```

The core is plain ESM JavaScript with JSDoc types and no runtime dependencies, so the plugin installs
from git with no build step. The Orca worker is TypeScript that Orca (and Node's type stripping in
tests) runs directly.

## Roadmap

- [x] Eval harness: offline tracks in `bench/`
- [ ] Live A/B numbers with Claude Code (and superpowers) — harness ready in `bench/live/`
- [ ] Python (uv/poetry) and Go detection; monorepo `--affected`
- [ ] "Does your agent lie about done?" public benchmark
- [ ] Codex and Gemini CLI adapters

## License

MIT © Stanislav
