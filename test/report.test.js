// @ts-check
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { statusLine } from '../plugins/seaworthy/core/report.js'
import { repo } from './helpers.js'
import { setup } from './hooks/harness.js'

test('untracked repo → tracked:false and empty status line', async () => {
  const { main } = await import('../plugins/seaworthy/core/cli.js')
  const { captureIO } = await import('./helpers.js')
  const c = captureIO(repo())
  assert.equal(await main(['status', '--json'], c.io), 0)
  assert.equal(JSON.parse(c.out()).tracked, false)
})

test('status line follows the session', async () => {
  const t = setup()
  await t.start()
  assert.match((await t.cli(['status', '--line'])).out, /seaworthy ▸ checks ··· · review — · CI —/)
  writeFileSync(join(t.dir, 'src/a.txt'), 'bad\n')
  await t.cli(['check', '--tier', 'commit'])
  assert.match((await t.cli(['status', '--line'])).out, /checks ✓✗· \(test 1\/3\) · review — · CI —/)
  writeFileSync(join(t.dir, 'src/a.txt'), 'ok\n')
  await t.cli(['check', '--tier', 'push'])
  await t.approve()
  assert.match((await t.cli(['status', '--line'])).out, /checks ✓✓✓ · review ✓ · CI —/)
  assert.equal(statusLine({ tracked: true, tampered: 'x', session: false, phase: null, task: null, branch: null, checks: { fast: 'none', commit: 'none', push: 'none' }, failed: [], guard: { open: 0, ids: [] }, review: 'none', ci: { status: 'none', prUrl: null, cycles: 0 }, gitHooks: false, escalation: null, updatedAt: null }, null), 'seaworthy ▸ ⚠ state tampered — run `seaworthy stop`')
})

test('report never claims success while work is open; escalated report lists not-done items', async () => {
  const t = setup()
  await t.start()
  let r = await t.cli(['report', '--final'])
  assert.equal(r.code, 1)
  assert.match(r.out, /⏳ Not finished/)
  assert.match(r.out, /commit checks none/)
  assert.match(r.out, /Next: run `seaworthy check --tier commit`/)
  for (let i = 0; i < 6; i++) await t.hook('stop', {})
  r = await t.cli(['report'])
  assert.match(r.out, /⛔ Not shipped \(escalated\)/)
  assert.match(r.out, /escalation: stopped after 5 attempts/)
})

test('approve records the decision with its reason', async () => {
  const t = setup()
  await t.start()
  assert.equal((await t.cli(['approve', 'g-12345678', '--reason', 'intended refactor'])).code, 0)
  const s = JSON.parse((await t.cli(['state', '--json'])).out)
  assert.deepEqual(s.approvals['g-12345678'].reason, 'intended refactor')
})
