// @ts-check
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HANDLERS } from '../plugins/seaworthy/core/hooks/handlers.js'
import { ROOT } from './helpers.js'

const PLUGIN = join(ROOT, 'plugins', 'seaworthy')
const read = (/** @type {string} */ p) => JSON.parse(readFileSync(p, 'utf8'))

test('marketplace points at the plugin directory', () => {
  const m = read(join(ROOT, '.claude-plugin', 'marketplace.json'))
  assert.equal(m.name, 'seaworthy')
  assert.equal(m.plugins[0].name, 'seaworthy')
  assert.ok(existsSync(join(ROOT, m.plugins[0].source, '.claude-plugin', 'plugin.json')))
})

test('plugin.json is valid and names match', () => {
  const p = read(join(PLUGIN, '.claude-plugin', 'plugin.json'))
  assert.equal(p.name, 'seaworthy')
  assert.match(p.version, /^\d+\.\d+\.\d+$/)
  assert.doesNotMatch(p.name, /^(claude-|anthropic-|cc-plugin-)/)
  assert.equal(read(join(PLUGIN, 'package.json')).version, p.version)
})

test('every hook command targets an existing hook handler, wrapped in "hooks"', () => {
  const h = read(join(PLUGIN, 'hooks', 'hooks.json'))
  assert.ok(h.hooks, 'hooks.json must wrap the event map in a top-level "hooks" key')
  const events = Object.keys(h.hooks)
  assert.deepEqual(events.sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit'])
  for (const ev of events)
    for (const group of h.hooks[ev])
      for (const hook of group.hooks) {
        assert.equal(hook.type, 'command')
        const m = hook.command.match(/^node "\$\{CLAUDE_PLUGIN_ROOT\}\/core\/cli\.js" hook ([\w-]+)$/)
        assert.ok(m, hook.command)
        assert.ok(HANDLERS[m[1]], `no handler for ${m[1]}`)
        assert.ok(hook.timeout > 0 && hook.timeout <= 600)
      }
  assert.equal(h.hooks.SubagentStop[0].matcher, '^seaworthy:reviewer$')
})

test('skills and agents have frontmatter with name and description', () => {
  const skills = readdirSync(join(PLUGIN, 'skills'))
  assert.deepEqual(skills.sort(), ['init', 'ship', 'status', 'stop'])
  for (const s of skills) {
    const text = readFileSync(join(PLUGIN, 'skills', s, 'SKILL.md'), 'utf8')
    const fm = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? ''
    assert.match(fm, new RegExp(`^name: ${s}$`, 'm'))
    assert.match(fm, /^description: .{20,}$/m)
    assert.ok(text.split('\n').length < 500)
  }
  const ship = readFileSync(join(PLUGIN, 'skills', 'ship', 'SKILL.md'), 'utf8')
  assert.match(ship, /disable-model-invocation: true/)
  assert.match(ship, /claim --session "\$\{CLAUDE_SESSION_ID\}"/)
  const agent = readFileSync(join(PLUGIN, 'agents', 'reviewer.md'), 'utf8')
  assert.match(agent, /^name: reviewer$/m)
  assert.match(agent, /^tools: Read, Grep, Glob, Bash$/m)
  assert.doesNotMatch(agent, /^tools:.*\b(Edit|Write)\b/m)
})

test('bin shim is executable', () => {
  assert.ok(statSync(join(PLUGIN, 'bin', 'seaworthy')).mode & 0o111)
})
