// @ts-check
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { installGitHooks, gitHooksInstalled } from '../plugins/seaworthy/core/git-hooks.js'
import { sh, writeFiles } from './helpers.js'
import { setup } from './hooks/harness.js'

/** @param {string} dir @param {Record<string,string>} env @param {string[]} args */
const gitc = (dir, env, args) => spawnSync('git', args, { cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8' })

test('outside a session commits pass through the hooks', async () => {
  const t = setup()
  await installGitHooks(t.dir)
  writeFileSync(join(t.dir, 'src/a.txt'), 'ok\n2\n')
  const r = gitc(t.dir, t.env, ['commit', '-qam', 'feat: change'])
  assert.equal(r.status, 0, r.stderr)
})

test('during a session git refuses a commit when gates are red, even via --no-verify-free paths', async () => {
  const t = setup()
  await installGitHooks(t.dir)
  await t.start()
  writeFileSync(join(t.dir, 'src/a.txt'), 'ok\n2\n')
  const r = gitc(t.dir, t.env, ['commit', '-qam', 'feat: sneaky'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /seaworthy refused this commit/)
  assert.match(r.stderr, /commit checks have not passed/)
})

test('commit-msg refuses unknown trailers; green + approved commits pass', async () => {
  const t = setup()
  await installGitHooks(t.dir)
  await t.start()
  writeFileSync(join(t.dir, 'src/a.txt'), 'ok\n2\n')
  await t.cli(['check', '--tier', 'commit'])
  await t.approve()
  let r = gitc(t.dir, t.env, ['commit', '-qam', 'feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /co-authored-by/)
  r = gitc(t.dir, t.env, ['commit', '-qam', 'feat: x'])
  assert.equal(r.status, 0, r.stderr)
})

test('existing hook still runs (chained), and core.hooksPath (husky) is respected', async () => {
  const t = setup()
  writeFiles(t.dir, { '.husky/_/pre-commit': '#!/bin/sh\necho prev-ran >> "$(git rev-parse --show-toplevel)/prev.log"\n' })
  sh(t.dir, ['chmod', '+x', '.husky/_/pre-commit'])
  sh(t.dir, ['git', 'config', 'core.hooksPath', '.husky/_'])
  const res = await installGitHooks(t.dir)
  assert.deepEqual(res.chained, ['pre-commit'])
  assert.ok(res.hooksDir.endsWith('.husky/_'))
  assert.ok(await gitHooksInstalled(t.dir))
  writeFileSync(join(t.dir, 'src/a.txt'), 'ok\n3\n')
  sh(t.dir, ['sh', '-c', 'echo prev.log >> .gitignore'])
  const r = gitc(t.dir, t.env, ['commit', '-qam', 'chore: y'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(readFileSync(join(t.dir, 'prev.log'), 'utf8'), /prev-ran/)
})

test('pre-push refuses during a session when push checks are missing', async () => {
  const t = setup()
  await installGitHooks(t.dir)
  const bare = join(t.dir, '..', `remote-${Date.now()}.git`)
  sh(t.dir, ['git', 'init', '-q', '--bare', bare])
  sh(t.dir, ['git', 'remote', 'add', 'origin', bare])
  await t.start()
  const r = gitc(t.dir, t.env, ['push', '-q', 'origin', 'feat/x'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /push checks/)
  await t.cli(['check', '--tier', 'push'])
  const ok = gitc(t.dir, t.env, ['push', '-q', 'origin', 'feat/x'])
  assert.equal(ok.status, 0, ok.stderr)
})

test('init --yes installs the hooks and the core copy', async () => {
  const t = setup()
  sh(t.dir, ['rm', '.seaworthy.json'])
  writeFileSync(join(t.dir, 'package.json'), '{"scripts":{"test":"true"}}')
  const r = await t.cli(['init', '--yes'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /Git hooks: pre-commit, commit-msg, pre-push/)
  assert.ok(existsSync(join(t.dir, '.git', 'seaworthy-core', 'cli.js')))
})
