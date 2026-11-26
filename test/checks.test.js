// @ts-check
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { isGreen, lintFiles, recordResult, runTier } from '../plugins/seaworthy/core/checks.js'
import { newState } from '../plugins/seaworthy/core/state.js'
import { treeFingerprint } from '../plugins/seaworthy/core/git.js'
import { repo } from './helpers.js'

/** @param {Record<string,string>} checks @param {object} [extra] */
function project(checks, extra = {}) {
  const ids = Object.keys(checks)
  const cfg = {
    version: 1,
    packageManager: 'npm',
    checks: ids.map((id) => ({ id, cmd: checks[id], script: id })),
    tiers: { fast: ids.filter((i) => i === 'lint'), commit: ids.filter((i) => i !== 'build'), push: ids },
    caps: {},
    autonomy: 'normal',
    allowedTrailers: [],
    ...extra,
  }
  return repo({ '.seaworthy.json': JSON.stringify(cfg), '.gitignore': 'node_modules\n', 'src.txt': 'ok\n' })
}

const blank = () => newState({ sessionId: 's', task: '', autonomy: 'normal', branch: null, baseSha: null, startTree: '', configHash: '' })

test('records result bound to fingerprint; edit after green is not green', async () => {
  const dir = project({ lint: 'true', test: 'grep -q ok src.txt' })
  const r = await runTier(dir, 'commit')
  assert.equal(r.ok, true)
  assert.equal(r.tree, await treeFingerprint(dir))
  const s = blank()
  recordResult(s, r)
  assert.equal(isGreen(s, 'commit', r.tree), true)
  writeFileSync(join(dir, 'src.txt'), 'bad\n')
  const tree2 = await treeFingerprint(dir)
  assert.equal(isGreen(s, 'commit', tree2), false)
  const r2 = await runTier(dir, 'commit')
  assert.deepEqual(r2.failed, ['test'])
  recordResult(s, r2)
  assert.equal(s.counters.fix_attempts.test, 1)
})

test('timeout marks check failed with "timeout"', async () => {
  const dir = project({ lint: 'sleep 5' })
  const r = await runTier(dir, 'fast', { timeoutMs: 300 })
  assert.deepEqual(r.failed, ['lint (timeout)'])
})

test('push green implies commit and fast green', async () => {
  const dir = project({ lint: 'true', build: 'true' })
  const r = await runTier(dir, 'push')
  const s = blank()
  recordResult(s, r)
  assert.equal(isGreen(s, 'commit', r.tree), true)
  assert.equal(isGreen(s, 'fast', r.tree), true)
  assert.equal(isGreen(s, 'push', 'other'), false)
})

test('a check that edits the tree is not green', async () => {
  const dir = project({ lint: 'echo fmt >> src.txt' })
  const r = await runTier(dir, 'fast')
  assert.ok(r.failed.includes('tree changed during checks'))
})

test('lintFiles uses perFile command only when configured', async () => {
  const dir = project({ lint: 'true' })
  assert.deepEqual(await lintFiles(dir, ['src.txt']), { ran: false, ok: true, output: '' })
  const dir2 = repo({
    '.seaworthy.json': JSON.stringify({
      version: 1, packageManager: 'npm', autonomy: 'normal', allowedTrailers: [], caps: {},
      checks: [{ id: 'lint', cmd: 'true', script: 'lint', perFile: 'grep -L bad {files}' }],
      tiers: { fast: ['lint'], commit: ['lint'], push: ['lint'] },
    }),
    'a b.txt': 'fine',
  })
  const r = await lintFiles(dir2, ['a b.txt'])
  assert.equal(r.ran, true)
  assert.match(r.output, /a b.txt/)
})

test('checks run without preload variables or temp-dir PATH entries', async () => {
  const { checkEnv } = await import('../plugins/seaworthy/core/checks.js')
  const e = checkEnv({ PATH: '/tmp/fake:/usr/bin:/bin', NODE_OPTIONS: '--require=/tmp/x.cjs', GIT_DIR: '/x', HOME: '/h' })
  assert.equal(e.PATH, '/usr/bin:/bin')
  assert.equal(e.NODE_OPTIONS, undefined)
  assert.equal(e.GIT_DIR, undefined)
  assert.equal(e.HOME, '/h')
})
