// @ts-check
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { detectProject } from '../plugins/seaworthy/core/detect.js'
import { FIXTURES, tmp } from './helpers.js'

const fx = (/** @type {string} */ n) => detectProject(join(FIXTURES, n))

test('packageManager field wins over lockfile', async () => {
  assert.equal((await fx('pm-field')).packageManager, 'pnpm')
})

test('lockfile order', async () => {
  assert.equal((await fx('npm')).packageManager, 'npm')
  assert.equal((await fx('pnpm')).packageManager, 'pnpm')
  assert.equal((await fx('yarn')).packageManager, 'yarn')
  assert.equal((await fx('bun')).packageManager, 'bun')
  assert.equal((await fx('bun-legacy')).packageManager, 'bun')
  assert.equal((await fx('no-scripts')).packageManager, 'npm')
})

test('scripts map to checks', async () => {
  const p = await fx('pnpm')
  assert.deepEqual(
    p.checks.map((c) => [c.id, c.cmd]),
    [
      ['lint', 'pnpm run lint'],
      ['typecheck', 'pnpm run type-check'],
      ['test', 'pnpm run test'],
    ],
  )
  assert.equal((await fx('tsc-script')).checks[0].cmd, 'npm run tsc')
})

test('npm placeholder test ignored', async () => {
  const p = await fx('placeholder-test')
  assert.deepEqual(p.checks.map((c) => c.id), ['build'])
})

test('tiers', async () => {
  assert.deepEqual((await fx('npm')).tiers, {
    fast: ['lint', 'typecheck'],
    commit: ['lint', 'typecheck', 'test'],
    push: ['lint', 'typecheck', 'test', 'build'],
  })
  assert.deepEqual((await fx('yarn')).tiers, { fast: [], commit: ['test'], push: ['test'] })
})

test('no package.json is a clear error', async () => {
  await assert.rejects(detectProject(tmp()), /no package.json/)
})

test('per-file lint command for known linters', async () => {
  const p = await fx('pnpm')
  assert.equal(p.checks[0].perFile, 'pnpm exec eslint {files}')
  assert.equal((await fx('npm')).checks[0].perFile, 'npx eslint {files}')
})
