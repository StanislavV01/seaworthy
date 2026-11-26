// @ts-check
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { keyPath } from '../plugins/seaworthy/core/integrity.js'
import { clearState, loadState, newState, saveState, statePaths, TamperError, updateState } from '../plugins/seaworthy/core/state.js'
import { repo, sh, tmp } from './helpers.js'

const env = () => ({ SEAWORTHY_KEY_DIR: join(tmp(), 'key') })
const fresh = () =>
  newState({ sessionId: 's1', task: 't', autonomy: 'normal', branch: 'feat', baseSha: null, startTree: 'abc', configHash: 'h' })

test('round trip and update', async () => {
  const dir = repo()
  const e = env()
  assert.equal(await loadState(dir, e), null)
  await saveState(dir, e, fresh())
  const s = await loadState(dir, e)
  assert.equal(s?.session_id, 's1')
  await updateState(dir, e, (st) => {
    st.phase = 'review'
  })
  assert.equal((await loadState(dir, e))?.phase, 'review')
})

test('edited state fails verification with TamperError', async () => {
  const dir = repo()
  const e = env()
  await saveState(dir, e, fresh())
  const { file } = await statePaths(dir)
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.state.checks = { commit: { tree: 'x', ok: true, failed: [], at: '' } }
  writeFileSync(file, JSON.stringify(raw))
  await assert.rejects(loadState(dir, e), TamperError)
})

test('replaying an older signed copy is detected', async () => {
  const dir = repo()
  const e = env()
  await saveState(dir, e, fresh())
  const { file } = await statePaths(dir)
  const old = readFileSync(file, 'utf8')
  await updateState(dir, e, (st) => {
    st.phase = 'escalated'
  })
  writeFileSync(file, old)
  await assert.rejects(loadState(dir, e), /replaced/)
})

test('deleting state during a session is detected; clearState ends it cleanly', async () => {
  const dir = repo()
  const e = env()
  await saveState(dir, e, fresh())
  const { file } = await statePaths(dir)
  rmSync(file)
  await assert.rejects(loadState(dir, e), /missing/)
  await clearState(dir, e)
  assert.equal(await loadState(dir, e), null)
})

test('missing key file is created once with 0600', async () => {
  const dir = repo()
  const e = env()
  await saveState(dir, e, fresh())
  const k = keyPath(e)
  assert.ok(existsSync(k))
  assert.equal(statSync(k).mode & 0o777, 0o600)
  const before = readFileSync(k, 'utf8')
  await saveState(dir, e, fresh())
  assert.equal(readFileSync(k, 'utf8'), before)
})

test('state path is per worktree', async () => {
  const dir = repo()
  const wt = join(tmp(), 'wt')
  sh(dir, ['git', 'worktree', 'add', '-q', '-b', 'b2', wt])
  assert.notEqual((await statePaths(dir)).file, (await statePaths(wt)).file)
  const e = env()
  await saveState(dir, e, fresh())
  assert.equal(await loadState(wt, e), null)
})
