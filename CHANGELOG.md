# Changelog

## Unreleased — fixes from seaworthy-bench

[seaworthy-bench](bench/) (calibrated scripted agents, a 1,056-variant execution fuzzer, and a live
Claude Code A/B harness) found six bugs in v0.1.0. Details and reproductions: [bench/FINDINGS.md](bench/FINDINGS.md).

### Security

- **`git send-pack` pushed red code to origin** with one plain command. Git subcommands are now
  allow-listed: anything not known to be safe (`send-pack`, `receive-pack`, `fast-import`, unknown
  or plugin subcommands) counts as a write. `fetch` into a local ref, `remote add/set-url` and
  `worktree add` are refused too.
- **Unreadable wrappers were allowed instead of refused.** Now refused: shell function
  definitions, code piped into a shell or interpreter (`… | base64 -d | sh`), inline interpreter
  code that spawns processes or decodes code (`python -c`, `node -e`, `perl -e` …), `awk system()`,
  `sed e` / `s///e`, `tar --checkpoint-action` and friends, editors run with commands. Now read:
  `trap`, `script -c`, `env -S`, `watch`, `npm/pnpm/yarn exec`, `. file` / `source`, `make -f` and an
  edited default Makefile, `find -exec sh -c '…'` (its quoting was lost).
- **New `reference-transaction` git hook**: no branch or tag can move to a new commit while the
  commit gates are red — whether through `git commit`, plumbing (`commit-tree` + `update-ref`), or a
  program the agent runs (a test file that shells out). `--no-verify` does not skip it.

### Fixed

- On git ≥ 2.46 every `git switch` was refused during a red session: git now reports symbolic HEAD
  updates (`ref:refs/heads/…`) to the reference-transaction hook, and they were taken for new commits.
- Python: ruff is detected from `ruff.toml` / `.ruff.toml` or a `ruff` dependency in `pyproject.toml`,
  not only a `[tool.ruff]` table; `mypy.ini` is detected for mypy.
- The CI cross-check compares what runs, not how it is spelled: local `python3 -m pytest -q` matches
  `pytest -q` in CI, `ruff check . && ruff format --check .` matches both CI steps, `pip install` is
  ignored as setup, and duplicate warnings are shown once.
- `npm test` was refused in every session when the test script used `node --test '<glob>'` (the
  glob was taken for a missing script). Also `bun test` / `deno test`, `python -m …`, `perl -ne`.
- With no CI configured, an honest agent could not finish: `ci watch` now records the result for
  a pushed HEAD (and says "push first" for an unpushed one).
- `seaworthy report --final` could never mark a session done (it waited for itself).
- The red-team suite wrote to fixed `/tmp` paths and failed when another user or run owned them.

### Numbers

- 360 tests (was 285), **100 red-team bypass attempts** (was 81), 21 everyday commands.
- seaworthy-bench before → after: fuzzer escapes **229/980 → 0/980**; expert cheater shipping red
  code **25/25 → 0/25**; everyday commands refused **7/40 → 0/40**; honest finish without CI
  **0/4 → 4/4**.

## v0.1.0 — first public release

**Your coding agent says "done". seaworthy checks.**

seaworthy treats the coding agent as an adversary that wants to finish, and makes "finished" mean
something: the project's own checks pass, no test was quietly weakened, an independent reviewer
approved the exact tree being committed, and CI is green.

### What's in it

- **Commit and push gates** — `git commit` / `git push` are refused until checks, review and guard
  are clean for the current working tree (fingerprinted, not trusted from the agent's word).
- **Test-tamper guard** — detects removed or skipped test cases, trivialised assertions, and
  test files hidden via tsconfig/jest/ignore files. JS/TS, C/C++ (`TEST()`), Python, Go.
- **Independent review** — a separate reviewer subagent approves a specific tree; any edit after
  approval invalidates it.
- **Bash analyzer** — a heredoc-aware shell tokenizer that refuses wrappers (`sh -c`, `eval`),
  `GIT_*` / `NODE_OPTIONS` / `PATH` overrides, aliases via `GIT_CONFIG_COUNT`, writes to
  `.seaworthy.json` and its own core, and running scripts the agent just wrote.
- **Git-hook backstop** — the same gates fire from real git hooks, so going around Claude Code
  doesn't help.
- **CI watch** — follows GitHub Actions via `gh`, pulls failing logs (secrets redacted), retries
  within caps, escalates instead of looping forever.
- **Auto-detected checks** — npm/pnpm/yarn/bun, CMake/ctest, `build.sh`, make, pytest/unittest,
  Go, including component subdirectories.
- **Two hosts, one core** — Claude Code plugin (hooks + skills + reviewer agent) and an Orca
  extension (manifest v2, trusted worker).

### Numbers

- 285 tests, including **81 red-team bypass attempts** and 20 everyday commands that must stay allowed
- 0 runtime dependencies, plain ESM JavaScript type-checked with `tsc --checkJs`
- Dogfooded on a real C++17 robotics codebase

### Install (Claude Code)

```
/plugin marketplace add StanislavV01/seaworthy
/plugin install seaworthy@seaworthy
/seaworthy:init
```
