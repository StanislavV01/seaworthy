// @ts-check
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ROOT } from './helpers.js'

/** @type {any} */
const logic = await import(join(ROOT, 'orca', 'logic.ts'))

/** @param {object} o */
const st = (o = {}) => ({
  tracked: true, session: true, tampered: null, phase: 'implement', task: '', branch: 'feat/x',
  checks: { fast: 'green', commit: 'green', push: 'none' }, failed: [], guard: { open: 0, ids: [] },
  review: 'approve', ci: { status: 'none', prUrl: null, cycles: 0 }, gitHooks: true, escalation: null, updatedAt: null, ...o,
})

test('readiness and verdicts', () => {
  assert.equal(logic.verdict(st()), 'ready')
  assert.equal(logic.verdict(st({ review: 'changes_requested' })), 'blocked')
  assert.equal(logic.verdict(st({ guard: { open: 1, ids: ['g-1'] } })), 'blocked')
  assert.equal(logic.verdict(st({ tampered: 'x' })), 'tampered')
  assert.equal(logic.verdict(st({ checks: { fast: 'none', commit: 'none', push: 'none' } })), 'running')
  assert.equal(logic.verdict(null), 'untracked')
  assert.equal(logic.verdict(st({ session: false, review: 'none' })), 'ready')
})

test('score summary', () => {
  assert.deepEqual(logic.scoreSummary([]).text, 'seaworthy —')
  const s = logic.scoreSummary([st(), st({ checks: { fast: 'red', commit: 'red', push: 'none' } })])
  assert.equal(s.text, 'ship 1/2')
  assert.equal(s.tone, 'warning')
  assert.equal(logic.scoreSummary([st(), st({ guard: { open: 2, ids: [] } })]).tone, 'danger')
  assert.equal(logic.scoreSummary([st()]).tone, 'success')
})

test('only local, non-WSL git worktrees are tracked', () => {
  const ws = { id: 'w', kind: 'worktree', name: 'x', path: '/repo', branch: 'b', hostId: 'local' }
  assert.equal(logic.isLocalWorktree(ws), true)
  assert.equal(logic.isLocalWorktree({ ...ws, hostId: null }), true)
  assert.equal(logic.isLocalWorktree({ ...ws, hostId: 'ssh:box' }), false)
  assert.equal(logic.isLocalWorktree({ ...ws, kind: 'folder' }), false)
  assert.equal(logic.isLocalWorktree({ ...ws, path: '\\\\wsl.localhost\\Ubuntu\\repo' }), false)
  assert.equal(logic.resolveWorkspace([ws], null, 'w'), ws)
})

test('attaching the Claude plugin to a launch command', () => {
  assert.equal(logic.withClaudePlugin('claude', '/p/seaworthy'), 'claude --plugin-dir /p/seaworthy')
  assert.equal(logic.withClaudePlugin('/usr/local/bin/claude --resume x', '/p/s'), '/usr/local/bin/claude --plugin-dir /p/s --resume x')
  assert.equal(logic.withClaudePlugin('claude --plugin-dir /a', '/p/s'), 'claude --plugin-dir /a')
  assert.equal(logic.withClaudePlugin('codex', '/p/s'), 'codex')
  assert.equal(logic.withClaudePlugin('claude', '/My Plugins/s'), "claude --plugin-dir '/My Plugins/s'")
})

test('debouncer runs once per window and never concurrently', async () => {
  let t = 0
  const run = logic.createDebouncer(10_000, () => t)
  let calls = 0
  /** @type {(v?: unknown) => void} */
  let release = () => {}
  const first = run('a', () => new Promise((r) => { calls++; release = r }))
  assert.equal(await run('a', async () => calls++), null)
  release()
  await first
  t = 5_000
  assert.equal(await run('a', async () => calls++), null)
  t = 20_000
  await run('a', async () => calls++)
  assert.equal(calls, 2)
})

test('manifest is consistent with the files it names', () => {
  const m = JSON.parse(readFileSync(join(ROOT, 'orca-plugin.json'), 'utf8'))
  assert.equal(m.manifestVersion, 2)
  assert.equal(m.execution, 'trusted-worker')
  assert.ok(!m.publisher, 'publisher is derived from the repo owner')
  assert.doesNotMatch(m.id, /^orca-/)
  for (const p of [m.main, ...m.contributes.panels.map((/** @type {any} */ x) => x.entry)]) assert.ok(existsSync(join(ROOT, p)), p)
  const pkg = JSON.parse(readFileSync(join(ROOT, 'plugins', 'seaworthy', '.claude-plugin', 'plugin.json'), 'utf8'))
  assert.equal(m.version, pkg.version)
  const kinds = m.capabilities.map((/** @type {any} */ c) => c.kind).sort()
  assert.deepEqual(kinds, ['agent:read', 'notifications:show', 'settings:own', 'workspace:read'])
  const off = m.contributes.settings.filter((/** @type {any} */ s) => s.key !== 'notifyDoneButRed')
  assert.ok(off.every((/** @type {any} */ s) => s.default === false), 'opt-in features are off by default')
  for (const id of ['seaworthy.refresh', 'seaworthy.checkFocused']) assert.match(readFileSync(join(ROOT, 'orca', 'worker.ts'), 'utf8'), new RegExp(`register\\('${id.replace('.', '\\.')}'`))
})

test('worker module loads with Node type stripping', async () => {
  const mod = await import(join(ROOT, 'orca', 'worker.ts'))
  assert.equal(typeof mod.default, 'function')
})

/** A stand-in for Orca's worker API, recording host calls. */
function fakeOrca(/** @type {any[]} */ workspaces, /** @type {Record<string, unknown>} */ settings = {}) {
  /** @type {{ method: string, params: any }[]} */
  const calls = []
  /** @type {Record<string, Function>} */
  const events = {}
  /** @type {Record<string, Function>} */
  const handlers = {}
  /** @type {Record<string, Function>} */
  const hooks = {}
  /** @type {Record<string, Function>} */
  const commands = {}
  const orca = {
    log: () => {},
    host: {
      call: async (/** @type {string} */ method, /** @type {any} */ params) => {
        calls.push({ method, params })
        if (method === 'workspace.list') return { workspaces }
        if (method === 'settings.get') return { settings }
        if (method === 'workspace.readContext') return { workspaceId: workspaces[0]?.id }
        return { ok: true }
      },
    },
    events: { on: (/** @type {string} */ e, /** @type {Function} */ h) => (events[e] = h) },
    panels: { handle: (/** @type {string} */ n, /** @type {Function} */ h) => (handlers[n] = h), post: () => {} },
    commands: { register: (/** @type {string} */ n, /** @type {Function} */ h) => (commands[n] = h) },
    hooks: { on: (/** @type {string} */ n, /** @type {Function} */ h) => (hooks[n] = h) },
  }
  return { orca, calls, events, handlers, hooks, commands }
}

test('worker: an agent saying done on a red worktree triggers a notification', async () => {
  const { setup } = await import('./hooks/harness.js')
  const t = setup()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(t.dir, 'src/a.txt'), 'bad\n')
  const ws = { id: 'w1', kind: 'worktree', name: 'x', path: t.dir, branch: 'feat/x', hostId: 'local' }
  const f = fakeOrca([ws])
  const mod = await import(join(ROOT, 'orca', 'worker.ts'))
  await mod.default(f.orca)
  await f.events['agent.status.changed']({ workspaceId: 'w1', workspaceListId: 'w1', state: 'done', paneKey: 'p', receivedAt: 0 })
  const note = f.calls.find((c) => c.method === 'notifications.show')
  assert.ok(note, JSON.stringify(f.calls.map((c) => c.method)))
  assert.equal(note.params.title, 'Done, but red')
  assert.match(note.params.body, /feat\/x: test failing/)
  const bar = f.calls.filter((c) => c.method === 'statusBar.update').at(-1)
  assert.equal(bar?.params.text, 'ship 0/1')
  const rows = await f.handlers['ship.rows']()
  assert.equal(rows[0].verdict, 'blocked')
})

test('worker: opt-in hooks pass through when off, act when on', async () => {
  const { setup } = await import('./hooks/harness.js')
  const t = setup()
  process.env.SEAWORTHY_KEY_DIR = t.env.SEAWORTHY_KEY_DIR
  const ws = { id: 'w1', kind: 'worktree', name: 'x', path: t.dir, branch: 'feat/x', hostId: 'local' }
  const off = fakeOrca([ws])
  const mod = await import(join(ROOT, 'orca', 'worker.ts'))
  await mod.default(off.orca)
  const next = (/** @type {any} */ e) => e
  const launch = { agent: 'claude', workspaceId: 'w1', workspaceKind: 'worktree', command: 'claude', env: {} }
  assert.equal((await off.hooks['agent.launch.before'](launch, next)).command, 'claude')
  const on = fakeOrca([ws], { autoAttachClaudePlugin: true, gateClaudeCommits: true })
  await mod.default(on.orca)
  assert.match((await on.hooks['agent.launch.before'](launch, next)).command, /^claude --plugin-dir .*plugins\/seaworthy/)
  await t.start()
  const denied = await on.hooks['agent.tool.before']({ agent: 'claude', workspaceId: 'w1', tool: 'Bash', input: { command: 'git commit -m x' } }, next)
  assert.match(denied.deny, /commit refused/)
  const passed = await on.hooks['agent.tool.before']({ agent: 'claude', workspaceId: 'w1', tool: 'Bash', input: { command: 'ls' } }, next)
  assert.equal(passed.tool, 'Bash')
})
