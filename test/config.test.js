// @ts-check
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { main } from '../plugins/seaworthy/core/cli.js'
import { canonicalJson, configHash, DEFAULT_CAPS, loadConfig, validateConfig } from '../plugins/seaworthy/core/config.js'
import { captureIO, fixtureCopy } from './helpers.js'

test('init --yes writes config with default caps and normal autonomy', async () => {
  const dir = fixtureCopy('npm')
  const c = captureIO(dir)
  assert.equal(await main(['init', '--yes'], c.io), 0, c.err())
  const cfg = JSON.parse(readFileSync(join(dir, '.seaworthy.json'), 'utf8'))
  assert.equal(cfg.autonomy, 'normal')
  assert.deepEqual(cfg.caps, DEFAULT_CAPS)
  assert.equal(cfg.caps.ciCycles, 3)
  assert.deepEqual(cfg.allowedTrailers, [])
  assert.deepEqual((await loadConfig(dir))?.tiers.commit, ['lint', 'typecheck', 'test'])
})

test('init without --yes only describes', async () => {
  const dir = fixtureCopy('pnpm')
  const c = captureIO(dir)
  assert.equal(await main(['init'], c.io), 0)
  assert.match(c.out(), /package manager\s+pnpm/)
  assert.equal(await loadConfig(dir), null)
})

test('init refuses to overwrite without --force', async () => {
  const dir = fixtureCopy('npm')
  await main(['init', '--yes'], captureIO(dir).io)
  const c = captureIO(dir)
  assert.equal(await main(['init', '--yes'], c.io), 1)
  assert.match(c.err(), /already exists/)
})

test('canonical JSON hash is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [1, { f: 1, e: 2 }] } }), '{"a":{"c":[1,{"e":2,"f":1}],"d":2},"b":1}')
  assert.equal(configHash({ a: 1, b: 2 }), configHash({ b: 2, a: 1 }))
})

test('invalid config rejected with field name', () => {
  const ok = { version: 1, packageManager: 'npm', checks: [{ id: 'lint', cmd: 'npm run lint' }], tiers: { fast: ['lint'], commit: ['lint'], push: ['lint'] }, autonomy: 'normal', allowedTrailers: [] }
  assert.doesNotThrow(() => validateConfig(ok))
  assert.throws(() => validateConfig({ ...ok, autonomy: 'yolo' }), /autonomy/)
  assert.throws(() => validateConfig({ ...ok, tiers: { ...ok.tiers, push: ['build'] } }), /tiers.push references unknown check "build"/)
  assert.throws(() => validateConfig({ ...ok, checks: [{ id: 'lint', cmd: '' }] }), /checks\[0\].cmd/)
  assert.throws(() => validateConfig({ ...ok, caps: { ciCycles: -1 } }), /caps.ciCycles/)
})
