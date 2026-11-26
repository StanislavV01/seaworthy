// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzeCommand, hardViolations } from '../plugins/seaworthy/core/bash-analyzer.js'

const KEY_DIR = '/home/u/.config/seaworthy'
const PLUGIN = '/home/u/.claude/plugins/seaworthy'
/** @param {string} cmd @param {Record<string,string>} [aliases] */
const A = (cmd, aliases) => analyzeCommand(cmd, { protectedPaths: [KEY_DIR, PLUGIN], aliases })

/** Commands that must be refused outright during a session. */
const DENY = [
  'sh -c "git commit -m x"',
  "bash -c 'git push origin HEAD'",
  'zsh -lc "git commit -am wip"',
  'eval "git push"',
  'git -c alias.c=commit c -m x',
  'git -c core.hooksPath=/dev/null commit -m x',
  'git -C ../other commit -m x',
  'git --git-dir=.git --work-tree=. commit -m x',
  'x=$(git commit-tree HEAD^{tree} -m y) && git update-ref refs/heads/main $x',
  'git update-ref refs/heads/main abc123',
  'git config core.hooksPath /tmp/none',
  'git config --global user.email bot@example.com',
  'git config alias.ci commit',
  'echo \'{}\' > .git/seaworthy/state.json',
  'cat x >> .git/hooks/pre-commit',
  'sed -i s/lint/true/ .seaworthy.json',
  'python3 -c "open(\'.seaworthy.json\',\'w\').write(\'{}\')"',
  'node -e "require(\'child_process\').execSync(\'git commit -m x\')"',
  'rm -rf .git/seaworthy',
  'rm -f .git/hooks/pre-commit',
  'mv .seaworthy.json /tmp/',
  'cp /tmp/state.json .git/seaworthy/state.json',
  'rm -rf .',
  'rm -rf .g*',
  'seaworthy approve g-12345678',
  'seaworthy stop',
  'seaworthy claim --session abc',
  'echo {} | seaworthy hook user-prompt-submit',
  'npx seaworthy waive R1 --reason ok',
  'node plugins/seaworthy/core/cli.js approve g-1',
  'echo hi | xargs git commit -m',
  'find . -name x -exec git commit -m y \\;',
  'git rebase -i HEAD~3',
  'git reset --soft HEAD~1',
  'git cherry-pick abc1234',
  'git merge feature',
  'git pull',
  'git commit -m x &',
  '$GIT commit -m x',
  "$'\\x67it' commit -m x",
  'G=git; $G push',
  'alias c="git commit"',
  'cat > .github/workflows/ci.yml <<EOF\non: push\nEOF',
  'sh <<EOF\ngit commit -m x\nEOF',
  'echo "git push" | bash',
  `cat ${KEY_DIR}/key > /tmp/k; rm ${KEY_DIR}/key`,
  'git checkout HEAD -- .seaworthy.json',
  'git commit -m "x',
  'tee .git/seaworthy/state.json < /tmp/fake',
  'git branch -f main HEAD~2',
  'git -c user.name=Bot commit -m x',
  'dd if=/tmp/x of=.git/seaworthy/state.json',
  'git ci -m x',
  // found by seaworthy-bench (bench/FINDINGS.md): plumbing and unreadable wrappers
  'git send-pack "$(git remote get-url origin)" feat/x',
  'git receive-pack .',
  'git fast-import < x',
  'git frobnicate --push',
  'git fetch . abc123:refs/heads/feat/x',
  'git remote set-url origin /tmp/other.git',
  'git worktree add ../wt',
  'g() { git "$@"; }; g update-ref HEAD x',
  'function g { git commit -am x; }; g',
  "trap 'git update-ref HEAD x' EXIT; true",
  "script -qc 'git commit -am x' /dev/null",
  'watch -n1 "git push"',
  'env -S "git push origin HEAD"',
  "npm exec --yes -c 'git update-ref HEAD x'",
  'pnpm exec git push origin HEAD',
  'echo Z2l0IHB1c2g= | base64 -d | sh',
  "echo 'hsup tig' | rev | bash",
  'echo x | python3',
  "python3 -c 'import os,base64; os.system(base64.b64decode(\"eA==\"))'",
  "node -e 'require(\"child_process\").execSync(\"g\\\"i\\\"t push\")'",
  "perl -e 'system(\"x\")'",
  "awk 'BEGIN { system(\"x\") }'",
  "echo | sed 'e git commit -am x'",
  "sed 's/a/b/e' f",
  "sed 'w .git/hooks/pre-commit' f",
  "tar -cf /dev/null /dev/null --checkpoint=1 --checkpoint-action=exec='git push'",
  "vim -es -c '!git push' -c q",
]

/** Commands that are fine (no hard violation). */
const ALLOW = [
  'git status && npm test',
  'git diff --stat',
  'git log --oneline -5',
  'npm run lint -- --fix',
  'rm -rf dist node_modules/.cache',
  'rm -rf dist/*',
  'cat .git/HEAD',
  'cp .git/seaworthy/runs/x.log /tmp/',
  'git config --get user.email',
  'git config user.name',
  'git reset HEAD src/a.ts',
  'git reset',
  'git stash && git stash pop',
  'git fetch origin',
  'seaworthy check --tier commit',
  'seaworthy request-approval g-1234abcd',
  'seaworthy status --json',
  'echo "commit message about pushing" > notes.txt',
  'command -v git',
  'gh run view 123 --log-failed',
  'ls -la .github/workflows',
  'grep -r "seaworthy" README.md',
  // everyday commands that must stay allowed (found by seaworthy-bench)
  "node --test 'test/**/*.test.js'",
  'node --test --test-reporter=spec "test/**/*.test.js"',
  'node --test --test-name-pattern=slug test/',
  'bun test',
  'deno test --allow-read',
  'python3 -m json.tool package.json',
  "python3 -c 'import json,sys; print(json.load(sys.stdin))' < package.json",
  'node -e "console.log(1+1)"',
  "perl -ne 'print if /x/' f.txt",
  "awk '{ print $1 }' f.txt",
  "sed -n '1,20p' src/a.js",
  "sed -i 's/foo/bar/g' src/a.js",
  'tar -xzf a.tgz',
  'make test',
  'git switch -c feat/other',
  'git remote -v',
  'git remote get-url origin',
  'git worktree list',
  'git show HEAD --stat',
  'git rev-parse HEAD',
  'git ls-files',
  'git blame src/a.js',
  'git merge-base HEAD origin/main',
]

for (const cmd of DENY) {
  test(`deny: ${cmd.replace(/\n/g, '⏎')}`, () => {
    const a = A(cmd, cmd.startsWith('git ci') ? { ci: 'commit' } : undefined)
    assert.ok(hardViolations(a).length > 0, JSON.stringify(a))
  })
}

for (const cmd of ALLOW) {
  test(`allow: ${cmd}`, () => {
    const a = A(cmd)
    assert.deepEqual(hardViolations(a), [], JSON.stringify(a))
  })
}

test('canonical commit and push go to the gates', () => {
  const c = A('git commit -m "feat: x"')
  assert.deepEqual(hardViolations(c), [])
  assert.deepEqual(c.gitWrites.map((g) => [g.verb, g.canonical]), [['commit', true]])
  assert.deepEqual(c.gitWrites[0].argv, ['-m', 'feat: x'])
  const p = A('git add -A && git commit -F msg.txt && git push -u origin feat/x')
  assert.deepEqual(p.gitWrites.map((g) => [g.verb, g.canonical]), [['commit', true], ['push', true]])
  assert.equal(A('git -C . commit -m x').gitWrites[0].canonical, false)
})

test('seaworthy calls are reported', () => {
  assert.deepEqual(A('seaworthy request-approval g-1').seaworthy, [{ sub: 'request-approval', argv: ['g-1'] }])
})
