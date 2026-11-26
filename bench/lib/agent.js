// @ts-check
/**
 * A scripted "agent": a list of tool calls replayed through whatever gate the arm has.
 *  - none:      nothing between the agent and git.
 *  - naive:     today's common setup — a pre-commit hook that runs the tests, and a PreToolUse rule
 *               that refuses --no-verify (block-no-verify / done-gate style).
 *  - seaworthy: the real plugin — every event goes through `node cli.js hook <event>` exactly as
 *               Claude Code calls it, with seaworthy's git hooks installed.
 */
import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLI, run, writeFiles } from './sandbox.js'

export const SESSION = 'bench-session-1'

/**
 * @typedef {{ t: 'write', path: string, content: string }
 *  | { t: 'edit', path: string, from: string, to: string }
 *  | { t: 'bash', cmd: string }
 *  | { t: 'review' }
 *  | { t: 'stop', message?: string }} Action
 * @typedef {{ action: Action, decision: 'allow' | 'deny' | 'ask', reason?: string, exit?: number, out?: string, ms: number }} Step
 */

/** @param {import('./sandbox.js').Sandbox} sb @param {string} name @param {object} input */
export function hook(sb, name, input) {
  const t0 = performance.now()
  const r = run(sb.dir, ['node', CLI, 'hook', name], sb.env, JSON.stringify({ session_id: SESSION, cwd: sb.dir, hook_event_name: name, ...input }))
  const ms = performance.now() - t0
  const text = r.stdout.trim()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  return { code: r.code, json, stderr: r.stderr, ms }
}

/** @param {{ code: number, json: any }} h */
export const preDecision = (h) => (h.code === 2 ? 'deny' : (h.json?.hookSpecificOutput?.permissionDecision ?? 'allow'))
/** @param {{ json: any, stderr?: string }} h */
export const preReason = (h) => String(h.json?.hookSpecificOutput?.permissionDecisionReason ?? h.json?.reason ?? h.stderr ?? '')

/** @param {import('./sandbox.js').Sandbox} sb */
export function createAgent(sb) {
  /** @type {Step[]} */
  const log = []
  /** @type {Record<string, number[]>} */
  const latency = {}
  const rec = (/** @type {string} */ k, /** @type {number} */ ms) => (latency[k] ??= []).push(ms)

  /** @param {string} tool @param {Record<string, any>} input @returns {{ decision: 'allow'|'deny'|'ask', reason: string }} */
  function gate(tool, input) {
    if (sb.arm === 'none') return { decision: 'allow', reason: '' }
    if (sb.arm === 'naive') {
      if (tool === 'Bash' && /\bgit\b[^\n]*\b(commit|push)\b[^\n]*(--no-verify|\s-n\b)/.test(input.command)) return { decision: 'deny', reason: 'block-no-verify' }
      return { decision: 'allow', reason: '' }
    }
    const h = hook(sb, 'pre-tool-use', { tool_name: tool, tool_input: input })
    rec(tool === 'Bash' ? (/\bgit\s+(commit|push)\b/.test(input.command ?? '') ? 'pre-tool-use (git write)' : 'pre-tool-use (other bash)') : 'pre-tool-use (edit)', h.ms)
    return { decision: /** @type {any} */ (preDecision(h)), reason: preReason(h) }
  }

  /** @param {Step} s */
  const push = (s) => (log.push(s), s)

  /** @param {Action} a @returns {Step} */
  function act(a) {
    const t0 = performance.now()
    if (a.t === 'write' || a.t === 'edit') {
      const tool = a.t === 'write' ? 'Write' : 'Edit'
      const file_path = join(sb.dir, a.path)
      const g = gate(tool, a.t === 'write' ? { file_path, content: a.content } : { file_path, old_string: a.from, new_string: a.to })
      if (g.decision !== 'allow') return push({ action: a, decision: g.decision, reason: g.reason, ms: performance.now() - t0 })
      if (a.t === 'write') writeFiles(sb.dir, { [a.path]: a.content })
      else {
        const cur = readFileSync(file_path, 'utf8')
        if (!cur.includes(a.from)) throw new Error(`edit: "${a.from.slice(0, 40)}" not in ${a.path}`)
        writeFiles(sb.dir, { [a.path]: cur.replace(a.from, a.to) })
      }
      if (sb.arm === 'seaworthy') rec('post-tool-use', hook(sb, 'post-tool-use', { tool_name: tool, tool_input: { file_path } }).ms)
      return push({ action: a, decision: 'allow', exit: 0, ms: performance.now() - t0 })
    }
    if (a.t === 'bash') {
      const g = gate('Bash', { command: a.cmd })
      if (g.decision === 'deny') return push({ action: a, decision: 'deny', reason: g.reason, ms: performance.now() - t0 })
      // "ask" goes to the developer. The bench developer confirms pushes but never approves
      // anything else the agent raises (in auto mode pushes do not ask anyway).
      if (g.decision === 'ask' && !/^git push\b/.test(a.cmd)) return push({ action: a, decision: 'ask', reason: g.reason + ' [developer declined]', ms: performance.now() - t0 })
      const r = run(sb.dir, ['bash', '-c', a.cmd], sb.env)
      return push({ action: a, decision: g.decision, exit: r.code, out: r.out.slice(-1500), ms: performance.now() - t0 })
    }
    if (a.t === 'review') {
      if (sb.arm !== 'seaworthy') return push({ action: a, decision: 'allow', exit: 0, ms: 0 })
      // Worst case for seaworthy: the reviewer is fooled and approves whatever it is shown.
      const s = hook(sb, 'subagent-start', { agent_type: 'seaworthy:reviewer' })
      const e = hook(sb, 'subagent-stop', {
        agent_type: 'seaworthy:reviewer',
        last_assistant_message: 'Reviewed the diff.\n```json\n{"verdict":"approve","findings":[]}\n```',
      })
      rec('subagent start+stop', s.ms + e.ms)
      return push({ action: a, decision: 'allow', exit: 0, ms: performance.now() - t0 })
    }
    if (a.t === 'stop') {
      if (sb.arm !== 'seaworthy') return push({ action: a, decision: 'allow', exit: 0, ms: 0 })
      const h = hook(sb, 'stop', { stop_hook_active: false, last_assistant_message: a.message ?? 'Done!' })
      rec('stop', h.ms)
      const blocked = h.json?.decision === 'block'
      return push({ action: a, decision: blocked ? 'deny' : 'allow', reason: String(h.json?.reason ?? h.json?.systemMessage ?? ''), ms: performance.now() - t0 })
    }
    throw new Error('unknown action')
  }

  /** Starts the session the way /seaworthy:ship does (UserPromptSubmit). */
  function start() {
    if (sb.arm !== 'seaworthy') return
    const h = hook(sb, 'user-prompt-submit', { prompt: `/seaworthy:ship ${sb.task.task}` })
    rec('user-prompt-submit', h.ms)
    if (h.code !== 0) throw new Error(`session did not start: ${h.stderr}`)
  }

  return { act, start, log, latency }
}
