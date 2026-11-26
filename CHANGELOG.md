# Changelog

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
