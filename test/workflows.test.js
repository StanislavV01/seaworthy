// @ts-check
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { branchMatches, ciRunsOnPush, crossCheck, hasPullRequestCi, readWorkflows } from '../plugins/seaworthy/core/workflows.js'
import { FIXTURES } from './helpers.js'

const wf = (/** @type {string} */ n) => readWorkflows(join(FIXTURES, 'workflows', n))

test('defi-agent shape: push main + pull_request', async () => {
  const w = await wf('push-main-and-pr')
  assert.equal(ciRunsOnPush(w, 'feat/x'), false)
  assert.equal(ciRunsOnPush(w, 'main'), true)
  assert.equal(hasPullRequestCi(w), true)
})

test('on: [push, pull_request] runs for any branch', async () => {
  assert.equal(ciRunsOnPush(await wf('push-all'), 'feat/anything'), true)
})

test('pull_request only never runs on push', async () => {
  const w = await wf('pr-only')
  assert.equal(ciRunsOnPush(w, 'main'), false)
  assert.equal(hasPullRequestCi(w), true)
})

test('branch lists and ignores', async () => {
  const w = await wf('list-branches')
  assert.equal(ciRunsOnPush(w, 'release/v1'), true)
  assert.equal(ciRunsOnPush(w, 'release/old'), false)
  assert.equal(ciRunsOnPush(w, 'feat/x'), false)
  assert.equal(branchMatches('release/*', 'release/a/b'), false)
  assert.equal(branchMatches('release/**', 'release/a/b'), true)
})

test('no workflows', async () => {
  assert.deepEqual(await wf('none'), [])
})

test('run steps include multiline blocks', async () => {
  const [w] = await wf('push-main-and-pr')
  assert.deepEqual(w.runSteps, ['npm install', 'npm run lint', 'npm run build', 'npx playwright install', 'npm run e2e'])
})

test('cross-check matches steps to checks and warns both ways', async () => {
  const w = await wf('push-main-and-pr')
  const warnings = crossCheck(
    {
      checks: [
        { id: 'lint', script: 'lint' },
        { id: 'test', script: 'test' },
        { id: 'build', script: 'build' },
      ],
    },
    w,
  )
  assert.ok(!warnings.some((x) => x.includes('npm run lint')))
  assert.ok(warnings.includes('local check test (`test`) does not run in CI'))
  assert.ok(!warnings.some((x) => x.includes('playwright install')))
  const pnpm = crossCheck({ checks: [{ id: 'test', script: 'test' }] }, await wf('push-all'))
  assert.deepEqual(pnpm, [])
})
