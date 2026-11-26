# Commits

- Look at the last ~20 subjects (`git log --format=%s -20`). Use the repository's style; if it uses
  Conventional Commits (or has no clear style), use `type(scope): subject` — types `feat`, `fix`,
  `refactor`, `test`, `docs`, `chore`, `ci`, `build`, `perf`.
- Group changes by concern: one commit per logical change a reviewer could accept or reject on its
  own (for example: the feature, its tests, an unrelated refactor). Small tasks are often one commit.
- Stage explicit paths: `git add src/theme.ts src/theme.test.ts`. For part of a file, write the hunk
  to a patch and `git apply --cached <patch>`.
- Commit with `git commit -m "type(scope): subject"` (add a second `-m "body"` for context, or
  `-F <file>` for long messages). Nothing else on the command line.
- The commit is made as the developer (their git config). Do not add `Co-Authored-By`, `Signed-off-by`
  or any other trailer the repository does not already use; seaworthy refuses them.
- Do not amend, rebase, reset, cherry-pick or merge during a session. If history needs rewriting,
  stop and ask the developer.
- The working tree must not change between the green checks and the commits (every commit is checked
  against the same code). If you need to change code, run the checks and the review again.
