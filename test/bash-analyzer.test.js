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
