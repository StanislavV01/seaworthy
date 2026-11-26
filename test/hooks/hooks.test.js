// @ts-check
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { statePaths } from '../../plugins/seaworthy/core/state.js'
import { sh } from '../helpers.js'
import { decision, reason, setup } from './harness.js'

test('noop when no session', async () => {
  const t = setup()
  for (const [name, input] of /** @type {[string, object][]} */ ([
    ['pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }],
    ['pre-tool-use', { tool_name: 'Write', tool_input: { file_path: '.seaworthy.json' } }],
    ['post-tool-use', { tool_name: 'Edit', tool_input: { file_path: 'src/a.txt' } }],
    ['stop', {}],
    ['subagent-stop', { agent_type: 'seaworthy:reviewer', last_assistant_message: 'x' }],
    ['session-start', { source: 'resume' }],
    ['user-prompt-submit', { prompt: 'just chatting' }],
  ])) {
    const r = await t.hook(name, input)
    assert.equal(r.code, 0, name)
    assert.equal(r.out, '', name)
  }
})

test('claims a session only on /seaworthy:ship', async () => {
  const t = setup()
  await t.hook('user-prompt-submit', { prompt: 'please ship it' })
  assert.match((await t.cli(['state'])).out + (await t.cli(['state'])).err, /no seaworthy session|null/)
  const r = await t.start('/seaworthy:ship --auto add dark mode')
  assert.match(r.json.hookSpecificOutput.additionalContext, /session started \(autonomy: auto\)/)
  const s = JSON.parse((await t.cli(['state', '--json'])).out)
  assert.equal(s.task, 'add dark mode')
  assert.equal(s.session_id, 'session-1')
})

test('commit denied when checks are stale, allowed when green + approved for the same tree', async () => {
  const t = setup()
  await t.start()
  let r = await t.bash('git commit -m "feat: x"')
  assert.equal(decision(r), 'deny')
  assert.match(reason(r), /commit checks have not passed/)
  assert.match(reason(r), /no approved review/)

  assert.equal((await t.cli(['check', '--tier', 'commit'])).code, 0)
  await t.approve()
  r = await t.bash('git commit -m "feat: x"')
  assert.equal(r.out, '', reason(r))

  writeFileSync(join(t.dir, 'src/a.txt'), 'ok\nmore\n')
  r = await t.bash('git commit -m "feat: x"')
  assert.equal(decision(r), 'deny')
  assert.match(reason(r), /not passed for the current code/)
})

test('commit denied with Co-Authored-By trailer or --no-verify', async () => {
  const t = setup()
  await t.start()
  await t.cli(['check', '--tier', 'commit'])
  await t.approve()
  let r = await t.bash('git commit -m "feat: x" -m "Co-Authored-By: Claude <noreply@anthropic.com>"')
  assert.match(reason(r), /co-authored-by/)
  r = await t.bash('git commit --no-verify -m "feat: x"')
  assert.equal(decision(r), 'deny')
})

test('commit denied with an unresolved guard event; request-approval asks; approval unblocks', async () => {
  const t = setup()
  await t.start()
  writeFileSync(join(t.dir, 'src/a.test.js'), "it('a', () => {})\n")
  await t.cli(['check', '--tier', 'commit'])
  await t.approve()
  let r = await t.bash('git commit -m "test: trim"')
  assert.equal(decision(r), 'deny')
  const id = reason(r).match(/guard (g-[0-9a-f]{8})/)?.[1]
  assert.ok(id, reason(r))
  r = await t.bash(`seaworthy request-approval ${id}`)
  assert.equal(decision(r), 'ask')
  assert.match(reason(r), /test_case_removed in src\/a.test.js/)
  r = await t.bash(`seaworthy approve ${id}`)
  assert.equal(decision(r), 'deny')
  assert.equal((await t.cli(['request-approval', id])).code, 0)
  r = await t.bash('git commit -m "test: trim"')
  assert.equal(r.out, '', reason(r))
})

test('stop, waive and approve are developer-only', async () => {
  const t = setup()
  await t.start()
  for (const c of ['seaworthy stop', 'seaworthy waive R1.1', 'seaworthy approve g-00000000', 'seaworthy allow-force-push']) assert.equal(decision(await t.bash(c)), 'deny', c)
})

test('push gates: default branch, force, uncommitted changes, normal mode asks', async () => {
  const t = setup()
  await t.start()
  assert.match(reason(await t.bash('git push origin main')), /default branch main/)
  assert.match(reason(await t.bash('git push --force origin feat/x')), /force push/)
  writeFileSync(join(t.dir, 'src/a.txt'), 'ok\n2\n')
  assert.match(reason(await t.bash('git push -u origin feat/x')), /uncommitted changes/)
  sh(t.dir, ['git', 'commit', '-qam', 'wip'])
  assert.match(reason(await t.bash('git push -u origin feat/x')), /push checks/)
  await t.cli(['check', '--tier', 'push'])
  const r = await t.bash('git push -u origin feat/x')
  assert.equal(decision(r), 'ask', reason(r))
})

test('protected files cannot be edited during a session', async () => {
  const t = setup()
  await t.start()
  for (const f of ['.seaworthy.json', '.git/seaworthy/state.json', '.github/workflows/ci.yml', join(t.env.SEAWORTHY_KEY_DIR, 'key')]) {
    const r = await t.hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: f } })
    assert.equal(decision(r), 'deny', f)
  }
  assert.equal((await t.hook('pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: 'src/a.txt' } })).out, '')
})

test('stop is blocked with the next step, then escalates after the cap', async () => {
  const t = setup()
  await t.start()
  for (let i = 1; i <= 5; i++) {
    const r = await t.hook('stop', { stop_hook_active: i > 1 })
    assert.equal(r.json?.decision, 'block')
    assert.match(r.json.reason, /seaworthy check --tier commit/)
    assert.match(r.json.reason, new RegExp(`continuation ${i}/5`))
  }
  const r = await t.hook('stop', { stop_hook_active: true })
  assert.match(r.json?.systemMessage ?? '', /escalated/)
  assert.equal(JSON.parse((await t.cli(['state', '--json'])).out).phase, 'escalated')
  assert.equal((await t.hook('stop', {})).out, '')
})

test('reviewer must return a JSON verdict; high findings mean changes requested', async () => {
  const t = setup()
  await t.start()
  let r = await t.hook('subagent-stop', { agent_type: 'seaworthy:reviewer', last_assistant_message: 'All good!' })
  assert.equal(r.json?.decision, 'block')
  r = await t.hook('subagent-stop', {
    agent_type: 'seaworthy:reviewer',
    last_assistant_message: '{"verdict":"approve","findings":[{"severity":"high","file":"src/a.txt","note":"bug"}]}',
  })
  assert.equal(r.out, '')
  const s = JSON.parse((await t.cli(['state', '--json'])).out)
  assert.equal(s.review.verdict, 'changes_requested')
  assert.equal(s.review.findings[0].id, 'R1.1')
  assert.equal((await t.hook('subagent-stop', { agent_type: 'Explore', last_assistant_message: 'x' })).out, '')
})

test('tampered state freezes git writes until the developer stops the session', async () => {
  const t = setup()
  await t.start()
  const { file } = await statePaths(t.dir)
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.state.review = { tree: 'x', verdict: 'approve', findings: [], at: '' }
  writeFileSync(file, JSON.stringify(raw))
  let r = await t.bash('git commit -m x')
  assert.match(reason(r), /tampered/)
  assert.equal((await t.bash('ls')).out, '')
  rmSync(file)
  r = await t.bash('git commit -m x')
  assert.match(reason(r), /tampered/)
  assert.equal((await t.cli(['stop'])).code, 0)
  assert.equal((await t.bash('git commit -m x')).out, '')
})

test('session start re-injects state after compaction', async () => {
  const t = setup()
  await t.start()
  const r = await t.hook('session-start', { source: 'compact' })
  assert.match(r.json.hookSpecificOutput.additionalContext, /seaworthy session in progress/)
})

test('claim (run by the skill) starts once and never resets the start snapshot', async () => {
  const t = setup()
  assert.match((await t.cli(['claim', '--session', 'session-1', '--', 'add', 'x'])).out, /session started/)
  const first = JSON.parse((await t.cli(['state', '--json'])).out).start_tree
  writeFileSync(join(t.dir, 'src/a.test.js'), "it('a', () => {})\n")
  assert.match((await t.cli(['claim', '--session', 'session-1'])).out, /session active/)
  assert.match((await t.cli(['claim', '--session', 'other'])).out, /resumed/)
  assert.equal(JSON.parse((await t.cli(['state', '--json'])).out).start_tree, first)
  assert.match((await t.cli(['claim', '--session', '${CLAUDE_SESSION_ID}'])).out, /no Claude Code session id/)
})
