# Fixing a red CI run

1. `seaworthy ci excerpt` — read the failing step and the first real error. The excerpt is redacted
   and bounded; the full log is on the run page it links.
2. Reproduce locally if you can (`seaworthy check --tier push` runs lint, typecheck, test and build).
   CI-only failures are usually: a build step that local checks skip, a missing env var, a different
   Node version, an import that only breaks the production bundle, or a case-sensitive path.
3. Fix the cause, not the symptom. Never skip, delete or loosen a failing test or check, and never
   edit `.github/workflows/` — if CI itself is wrong, stop and tell the developer.
4. If seaworthy reran the job once and it passed, it reports a flaky test; do not "fix" anything.
5. Then: `seaworthy check --tier commit` → `seaworthy guard` → review again → commit (`fix(ci): …`
   or the real scope) → `seaworthy check --tier push` → push → `seaworthy ci watch`.
6. Caps: after 3 CI fix cycles, or the same failure twice, or fixes that bounce between two
   failures, seaworthy escalates. Then run `seaworthy report` and explain what you found.
