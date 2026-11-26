// @ts-check
import assert from 'node:assert/strict'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { currentBranch, defaultBranch, diffTrees, gitDir, headSha, recentCommitMessages, treeFingerprint } from '../plugins/seaworthy/core/git.js'
import { repo, sh, tmp } from './helpers.js'

test('fingerprint changes after edit and returns after revert', async () => {
  const dir = repo({ 'a.txt': 'one\n' })
  const before = await treeFingerprint(dir)
  writeFileSync(join(dir, 'a.txt'), 'two\n')
  const after = await treeFingerprint(dir)
  assert.notEqual(before, after)
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  assert.equal(await treeFingerprint(dir), before)
})

test('untracked files count, ignored files do not', async () => {
  const dir = repo({ '.gitignore': 'dist/\n', 'a.txt': 'x' })
  const base = await treeFingerprint(dir)
  writeFileSync(join(dir, 'new.txt'), 'n')
  const withNew = await treeFingerprint(dir)
  assert.notEqual(base, withNew)
  sh(dir, ['mkdir', '-p', 'dist'])
  writeFileSync(join(dir, 'dist', 'out.js'), 'x')
  assert.equal(await treeFingerprint(dir), withNew)
})

test('does not touch the real index', async () => {
  const dir = repo({ 'a.txt': 'x' })
  writeFileSync(join(dir, 'b.txt'), 'y')
  await treeFingerprint(dir)
  assert.equal(sh(dir, ['git', 'diff', '--cached', '--name-only']).trim(), '')
  assert.match(sh(dir, ['git', 'status', '--porcelain']), /\?\? b.txt/)
})

test('works in a linked worktree with its own git dir', async () => {
  const dir = repo({ 'a.txt': 'x' })
  const wt = join(tmp(), 'wt')
  sh(dir, ['git', 'worktree', 'add', '-q', '-b', 'feat', wt])
  writeFileSync(join(wt, 'a.txt'), 'changed')
  assert.notEqual(await treeFingerprint(wt), await treeFingerprint(dir))
  assert.notEqual(await gitDir(wt), await gitDir(dir))
  assert.ok(existsSync(await gitDir(wt)))
  assert.equal(await currentBranch(wt), 'feat')
})

test('works in a repo with no commits', async () => {
  const dir = tmp()
  sh(dir, ['git', 'init', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'a.txt'), 'x')
  assert.match(await treeFingerprint(dir), /^[0-9a-f]{40}$/)
  assert.equal(await headSha(dir), null)
  assert.equal(await defaultBranch(dir), 'main')
})

test('diffTrees and recent messages', async () => {
  const dir = repo({ 'a.txt': 'x', 'b.txt': 'y' })
  const t0 = await treeFingerprint(dir)
  sh(dir, ['git', 'mv', 'b.txt', 'c.txt'])
  writeFileSync(join(dir, 'a.txt'), 'changed')
  const t1 = await treeFingerprint(dir)
  const d = await diffTrees(dir, t0, t1)
  assert.deepEqual(d.find((x) => x.path === 'a.txt'), { status: 'M', path: 'a.txt' })
  assert.deepEqual(d.find((x) => x.path === 'c.txt'), { status: 'R', oldPath: 'b.txt', path: 'c.txt' })
  assert.deepEqual(await recentCommitMessages(dir, 5), ['init'])
})
