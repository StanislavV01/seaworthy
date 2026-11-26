// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { main } from '../plugins/seaworthy/core/cli.js'
import { captureIO, tmp } from './helpers.js'

test('prints usage and exits 0 on --help', async () => {
  const c = captureIO(tmp())
  assert.equal(await main(['--help'], c.io), 0)
  assert.match(c.out(), /Usage: seaworthy <command>/)
})

test('unknown command exits 2 with "unknown command"', async () => {
  const c = captureIO(tmp())
  assert.equal(await main(['nope'], c.io), 2)
  assert.match(c.err(), /unknown command "nope"/)
})
