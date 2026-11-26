// @ts-check
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { afterCheckFailure, afterCiFailure, failureSignature } from '../plugins/seaworthy/core/caps.js'
import { failureExcerpt, summarize, watchRuns } from '../plugins/seaworthy/core/ci.js'
import { DEFAULT_CAPS } from '../plugins/seaworthy/core/config.js'
import { redact } from '../plugins/seaworthy/core/redact.js'
import { newState } from '../plugins/seaworthy/core/state.js'
import { ROOT, sh, tmp, writeFiles } from './helpers.js'
import { setup } from './hooks/harness.js'

const FAKE = join(ROOT, 'test', 'fake-gh')
/** @param {object} scenario */
function ghEnv(scenario) {
  const f = join(tmp(), 'scenario.json')
  writeFileSync(f, JSON.stringify(scenario))
  return { PATH: `${FAKE}:${process.env.PATH}`, FAKE_GH_SCENARIO: f, file: f }
}
const run = (/** @type {object} */ o) => ({ databaseId: 1, status: 'completed', conclusion: 'success', workflowName: 'CI', url: 'https://x/1', ...o })
const LOG = 'build\tRun npm test\t2026-11-26T01:00:00.000Z > vitest run\nbuild\tRun npm test\t2026-11-26T01:00:01.123Z FAIL src/a.test.ts > adds\nbuild\tRun npm test\t2026-11-26T01:00:01.200Z AssertionError: expected 3 to be 4\nbuild\tRun npm test\t2026-11-26T01:00:02.000Z token=ghp_abcdefghijklmnopqrstuvwxyz0123456789'

test('run appears after polls, then watch completes', async () => {
  const e = ghEnv({ runs: [[], [], [run({ status: 'in_progress', conclusion: '' })], [run({})]] })
  const r = await watchRuns(tmp(), 'abc', e, { maxMs: 5000, discoveryMs: 5000, pollMs: 10 })
  assert.equal(r.status, 'success')
  assert.match(readFileSync(e.file + '.calls', 'utf8'), /run watch 1 --exit-status --compact/)
})

test('watch error falls back to polling', async () => {
  const e = ghEnv({ watchError: true, runs: [[run({ status: 'queued', conclusion: '' })], [run({ status: 'in_progress', conclusion: '' })], [run({ conclusion: 'failure' })]] })
  const r = await watchRuns(tmp(), 'abc', e, { maxMs: 5000, discoveryMs: 1000, pollMs: 10 })
  assert.equal(r.status, 'failure')
})

test('no run within discovery window → none; pending past deadline → pending', async () => {
  assert.equal((await watchRuns(tmp(), 'abc', ghEnv({ runs: [[]] }), { maxMs: 100, discoveryMs: 50, pollMs: 10 })).status, 'none')
  const pending = ghEnv({ watchError: true, runs: [[run({ status: 'in_progress', conclusion: '' })]] })
  assert.equal((await watchRuns(tmp(), 'abc', pending, { maxMs: 60, discoveryMs: 10, pollMs: 10 })).status, 'pending')
})

test('summarize treats skipped/neutral as green', () => {
  assert.equal(summarize([run({}), run({ conclusion: 'skipped' })]), 'success')
  assert.equal(summarize([run({}), run({ conclusion: 'cancelled' })]), 'failure')
})

test('excerpt keeps error lines, is bounded and redacted', async () => {
  const e = ghEnv({ logFailed: LOG + '\n' + 'x\n'.repeat(5000) })
  const ex = await failureExcerpt(tmp(), 1, e, 8000)
  assert.ok(ex.text.length <= 8000)
  assert.match(ex.text, /AssertionError: expected 3 to be 4/)
  assert.doesNotMatch(ex.text, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/)
  assert.equal(ex.testOnly, true)
  assert.equal(ex.signature, (await failureExcerpt(tmp(), 1, ghEnv({ logFailed: LOG.replace(/01\.123Z/, '09.999Z') }), 8000)).signature)
})

test('redaction', () => {
  const s = redact('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB github_pat_11ABCDEFG0123456789_abcdefghijklmnop AKIAABCDEFGHIJKLMNOP sk-ant-api03-abcdefghijklmnopqrstuvwxyz API_KEY=supersecretvalue https://user:pass@example.com/x Bearer abcdefghijklmnopqrstuvwxyz123456')
  for (const leaked of ['ghp_0123', 'github_pat_11', 'AKIAABCD', 'sk-ant-api03-abc', 'supersecretvalue', 'user:pass', 'abcdefghijklmnopqrstuvwxyz123456'])
    assert.ok(!s.includes(leaked), `${leaked} leaked in ${s}`)
  assert.equal(redact('commit 8448169ab81ca98503e06ed8453a10a6c29aaa63 passed'), 'commit 8448169ab81ca98503e06ed8453a10a6c29aaa63 passed')
})

test('caps: rerun once, same signature escalates, oscillation escalates, cycle cap', () => {
  const s = newState({ sessionId: 's', task: '', autonomy: 'normal', branch: null, baseSha: null, startTree: '', configHash: '' })
  assert.equal(afterCiFailure(s, DEFAULT_CAPS, { sha: 'a', signature: 'A', testOnly: true }).action, 'rerun')
  assert.equal(afterCiFailure(s, DEFAULT_CAPS, { sha: 'a', signature: 'A', testOnly: true }).action, 'fix')
  assert.equal(afterCiFailure(s, DEFAULT_CAPS, { sha: 'b', signature: 'A', testOnly: false }).action, 'escalate')

  const o = newState({ sessionId: 's', task: '', autonomy: 'normal', branch: null, baseSha: null, startTree: '', configHash: '' })
  afterCiFailure(o, DEFAULT_CAPS, { sha: '1', signature: 'A', testOnly: false })
  afterCiFailure(o, DEFAULT_CAPS, { sha: '2', signature: 'B', testOnly: false })
  assert.match(afterCiFailure(o, DEFAULT_CAPS, { sha: '3', signature: 'A', testOnly: false }).reason, /oscillating/)

  const c = newState({ sessionId: 's', task: '', autonomy: 'normal', branch: null, baseSha: null, startTree: '', configHash: '' })
  c.ci.cycles = 3
  assert.equal(afterCiFailure(c, DEFAULT_CAPS, { sha: 'z', signature: 'Z', testOnly: false }).action, 'escalate')
  c.counters.fix_attempts.test = 4
  assert.equal(afterCheckFailure(c, DEFAULT_CAPS, ['test']).action, 'escalate')
  assert.equal(failureSignature('a.ts:10:5 failed in 12ms'), failureSignature('a.ts:99:1 failed in 3s'))
})

test('ci watch: missing gh is reported, not a crash', async () => {
  const t = setup()
  writeFiles(t.dir, { '.github/workflows/ci.yml': 'on: [push]\njobs: {}\n' })
  sh(t.dir, ['git', 'add', '-A'])
  sh(t.dir, ['git', 'commit', '-qm', 'ci'])
  const { main } = await import('../plugins/seaworthy/core/cli.js')
  const { captureIO } = await import('./helpers.js')
  const io = captureIO(t.dir, '', { ...t.env, PATH: '/nonexistent' })
  assert.equal(await main(['ci', 'watch'], io.io), 4)
  assert.match(io.out(), /cannot watch CI — gh \(GitHub CLI\) is not installed/)
})

test('ci watch opens a draft PR when CI only runs on pull_request, then reports green', async () => {
  const t = setup()
  writeFiles(t.dir, { '.github/workflows/ci.yml': 'on:\n  push:\n    branches: [main]\n  pull_request:\njobs: {}\n' })
  sh(t.dir, ['git', 'add', '-A'])
  sh(t.dir, ['git', 'commit', '-qm', 'ci'])
  await t.start()
  const e = ghEnv({ runs: [[run({})]] })
  const { main } = await import('../plugins/seaworthy/core/cli.js')
  const { captureIO } = await import('./helpers.js')
  const io = captureIO(t.dir, '', { ...t.env, PATH: e.PATH, FAKE_GH_SCENARIO: e.FAKE_GH_SCENARIO })
  assert.equal(await main(['ci', 'watch'], io.io), 0, io.out() + io.err())
  assert.match(io.out(), /CI green/)
  const s = JSON.parse((await t.cli(['state', '--json'])).out)
  assert.equal(s.ci.pr_url, 'https://github.com/o/r/pull/7')
  assert.equal(s.phase, 'report')
  assert.match(readFileSync(e.file + '.calls', 'utf8'), /pr create --draft --fill --base main --head feat\/x/)
})
