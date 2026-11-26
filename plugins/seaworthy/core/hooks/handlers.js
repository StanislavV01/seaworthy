// @ts-check
import { isAbsolute, relative, resolve } from 'node:path'
import { analyzeCommand, hardViolations, isProtectedPath } from '../bash-analyzer.js'
import { isGreen, lintFiles } from '../checks.js'
import { commitGate, pushGate } from '../gates.js'
import { git, headSha, treeFingerprint } from '../git.js'
import { openEvents, scanGuard } from '../guard.js'
import { isTerminal, logEvent, saveState } from '../state.js'
import { startOrResume } from '../session.js'
import { ask, block, context, deny, extraProtected, gitAliases, json, PASS } from './context.js'

/** @typedef {import('./context.js').HookContext} Ctx */
/** @typedef {import('./context.js').HookResult} HookResult */

const SHIP_PROMPT = /^\s*\/seaworthy:ship\b(.*)$/s

/**
 * Starts (or resumes) a session when the developer types `/seaworthy:ship`.
 * This is the only way a session begins, so the agent cannot switch gates on or off.
 * @param {Ctx} ctx
 * @returns {Promise<HookResult>}
 */
export async function userPromptSubmit(ctx) {
  const m = (ctx.input.prompt ?? '').match(SHIP_PROMPT)
  if (!m) return PASS
  if (ctx.tampered)
    return context('UserPromptSubmit', `seaworthy: the session state was tampered with (${ctx.tampered}). Do not continue the task. Tell the developer to inspect the repo and run \`seaworthy stop\` in their own terminal.`)
  if (!ctx.cfg) return context('UserPromptSubmit', 'seaworthy: no .seaworthy.json in this repository. Tell the developer to run /seaworthy:init first; do not start the loop.')
  if (!ctx.input.session_id) return PASS
  const msg = await startOrResume({ root: ctx.root, env: ctx.env, cfg: ctx.cfg, state: ctx.state, sessionId: ctx.input.session_id, raw: m[1] })
  return context('UserPromptSubmit', msg)
}

/**
 * @param {Ctx} ctx
 * @param {string} p
 */
function relToRoot(ctx, p) {
  const abs = isAbsolute(p) ? p : resolve(ctx.input.cwd || ctx.root, p)
  const rel = relative(ctx.root, abs)
  return { abs, rel: rel.startsWith('..') ? abs : rel }
}

/**
 * Gate for every tool call during a session.
 * @param {Ctx} ctx
 * @returns {Promise<HookResult>}
 */
export async function preToolUse(ctx) {
  const tool = ctx.input.tool_name ?? ''
  const ti = ctx.input.tool_input ?? {}
  const extra = extraProtected(ctx.env)
  const locked = Boolean(ctx.tampered)
  if (!ctx.active && !locked) return PASS

  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const target = String(ti.file_path ?? ti.notebook_path ?? '')
    if (!target) return PASS
    const { abs, rel } = relToRoot(ctx, target)
    if (isProtectedPath(rel, extra) || isProtectedPath(abs, extra))
      return deny(`${rel} is protected during a session (state, config, hooks and CI workflows). Changing checks or CI needs the developer: explain what and why instead.`)
    return PASS
  }
  if (tool !== 'Bash') return PASS

  const command = String(ti.command ?? '')
  const a = analyzeCommand(command, { protectedPaths: extra, aliases: await gitAliases(ctx.root) })
  if (locked) {
    if (a.gitWrites.length || a.protectedWrites.length || a.humanOnly.length)
      return deny(`the session state was tampered with (${ctx.tampered}); all git writes are frozen until the developer runs \`seaworthy stop\`.`)
    return PASS
  }
  const hard = hardViolations(a)
  if (hard.length) return deny(hard.join('; '))

  const approvalRequest = a.seaworthy.find((s) => s.sub === 'request-approval')
  if (approvalRequest && ctx.state) {
    const id = approvalRequest.argv.find((x) => !x.startsWith('-')) ?? ''
    const events = await scanGuard(ctx.root, ctx.state.start_tree)
    const ev = events.find((e) => e.id === id)
    const finding = ctx.state.review?.findings.find((f) => f.id === id)
    if (!ev && !finding) return deny(`no open guard event or review finding with id ${id}`)
    const what = ev ? `${ev.type} in ${ev.path} (${ev.detail})` : `review finding ${finding?.id}: ${finding?.note}`
    ctx.state.approval_requests[id] = { at: new Date().toISOString() }
    logEvent(ctx.state, 'approval-request', id)
    await saveState(ctx.root, ctx.env, ctx.state)
    return ask(`the agent asks you to APPROVE: ${what}. Allow only if this change is intended.`)
  }

  const state = /** @type {import('../state.js').State} */ (ctx.state)
  const cfg = ctx.cfg
  if (!cfg) return a.gitWrites.length ? deny('.seaworthy.json is missing; git writes are blocked during the session') : PASS

  for (const g of a.gitWrites) {
    if (g.verb === 'commit') {
      const r = await commitGate({ root: ctx.root, state, cfg, argv: g.argv, cwd: ctx.input.cwd || ctx.root })
      if (!r.ok) return deny(`commit refused:\n- ${r.reasons.join('\n- ')}`)
      if (state.autonomy === 'careful') return ask('careful mode: confirm this commit (checks green, review approved, no guard events).')
    } else if (g.verb === 'push') {
      const r = await pushGate({ root: ctx.root, state, cfg, argv: g.argv })
      if (!r.ok) return deny(`push refused:\n- ${r.reasons.join('\n- ')}`)
      if (state.autonomy !== 'auto') return ask(`push ${g.argv.join(' ')}: all gates are green. Confirm to push.`)
    }
  }
  return PASS
}

/**
 * Fast feedback on the file just edited.
 * @param {Ctx} ctx
 * @returns {Promise<HookResult>}
 */
export async function postToolUse(ctx) {
  if (!ctx.active) return PASS
  const ti = ctx.input.tool_input ?? {}
  const target = String(ti.file_path ?? '')
  if (!target) return PASS
  const { rel } = relToRoot(ctx, target)
  if (rel.startsWith('/')) return PASS
  const r = await lintFiles(ctx.root, [rel])
  if (!r.ran || r.ok) return PASS
  return block(`lint failed for ${rel}:\n${r.output.trim().slice(-2000)}`)
}

/**
 * What should happen next in the loop, or null when the session may stop.
 * @param {Ctx} ctx
 * @returns {Promise<string | null>}
 */
export async function nextStep(ctx) {
  const state = /** @type {import('../state.js').State} */ (ctx.state)
  const cfg = ctx.cfg
  if (!cfg) return null
  const tree = await treeFingerprint(ctx.root)
  const events = openEvents(await scanGuard(ctx.root, state.start_tree), state.approvals)
  const pending = events.filter((e) => state.approval_requests[e.id])
  if (pending.length && pending.length === events.length) return null
  if (events.length) return `resolve guard events first: ${events.map((e) => `${e.id} (${e.type} in ${e.path})`).join(', ')}. Revert them, or run \`seaworthy request-approval <id>\` to ask the developer.`
  if (!isGreen(state, 'commit', tree, cfg)) {
    const r = state.checks.commit
    return r && r.tree === tree ? `commit checks are red (${r.failed.join(', ')}). Fix them, then run \`seaworthy check --tier commit\`.` : 'run `seaworthy check --tier commit` on the current code.'
  }
  if (!state.review || state.review.tree !== tree || state.review.verdict !== 'approve') {
    if (state.review_rounds >= cfg.caps.reviewRounds && state.review?.tree === tree) return null
    return 'get a review: dispatch the seaworthy:reviewer agent with the task and `git diff` of the session.'
  }
  const head = await git(ctx.root, ['rev-parse', '--verify', '-q', 'HEAD^{tree}'])
  if (head.code !== 0 || head.stdout.trim() !== tree) return 'commit the work (Conventional Commits, grouped by concern, no trailers).'
  if (!isGreen(state, 'push', tree, cfg)) return 'run `seaworthy check --tier push` before pushing.'
  const sha = await headSha(ctx.root)
  if (state.ci.sha !== sha) return 'push the branch (`git push -u origin <branch>`), then run `seaworthy ci watch`.'
  const last = state.ci.runs.filter((r) => r.sha === sha).at(-1)
  if (!last || last.conclusion === 'pending') return 'CI is running: run `seaworthy ci watch` again.'
  if (last.conclusion !== 'success') return 'CI failed: run `seaworthy ci excerpt`, fix the cause locally, re-run checks, commit and push.'
  if (state.phase !== 'done') return 'everything is green: run `seaworthy report --final` to finish.'
  return null
}

/**
 * Keeps the agent from ending its turn while the loop is unfinished.
 * @param {Ctx} ctx
 * @returns {Promise<HookResult>}
 */
export async function stop(ctx) {
  if (ctx.tampered) return PASS
  if (!ctx.active || !ctx.state || isTerminal(ctx.state.phase)) return PASS
  const state = ctx.state
  const cap = ctx.cfg?.caps.stopBlocks ?? 5
  const step = await nextStep(ctx)
  if (!step) return PASS
  if (state.counters.stop_blocks >= cap) {
    state.phase = 'escalated'
    state.escalation = `stopped after ${cap} attempts to continue; last open step: ${step}`
    logEvent(state, 'escalate', state.escalation)
    await saveState(ctx.root, ctx.env, state)
    return json({ systemMessage: `seaworthy: escalated — ${state.escalation}` })
  }
  state.counters.stop_blocks++
  await saveState(ctx.root, ctx.env, state)
  return block(`${step} (continuation ${state.counters.stop_blocks}/${cap}; if you are truly stuck, explain why and run \`seaworthy report\` instead of finishing)`)
}

/**
 * Pulls the JSON verdict out of the reviewer's final message.
 * @param {string} text
 * @returns {{ verdict: 'approve' | 'changes_requested', findings: any[] } | null}
 */
export function parseVerdict(text) {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
  const candidates = fenced ? [fenced[1]] : []
  const brace = text.indexOf('{')
  if (brace >= 0) candidates.push(text.slice(brace, text.lastIndexOf('}') + 1))
  for (const c of candidates) {
    try {
      const v = JSON.parse(c)
      if ((v.verdict === 'approve' || v.verdict === 'changes_requested') && Array.isArray(v.findings)) return v
    } catch {
      /* try next */
    }
  }
  return null
}

/**
 * Records the reviewer's verdict for the exact code it reviewed.
 * @param {Ctx} ctx
 * @returns {Promise<HookResult>}
 */
export async function subagentStop(ctx) {
  if (!ctx.active || !ctx.state) return PASS
  const type = ctx.input.agent_type ?? ''
  if (type && !/(^|:)reviewer$/.test(type)) return PASS
  const msg = ctx.input.last_assistant_message
  if (typeof msg !== 'string') return PASS
  const v = parseVerdict(msg)
  if (!v) return block('end your review with a JSON block: {"verdict":"approve"|"changes_requested","findings":[{"severity":"high|medium|low","file":"…","line":1,"note":"…"}]}')
  const state = ctx.state
  const tree = await treeFingerprint(ctx.root)
  state.review_rounds++
  state.review = {
    tree,
    verdict: v.findings.some((f) => f && f.severity === 'high') ? 'changes_requested' : v.verdict,
    findings: v.findings.map((f, i) => ({ id: `R${state.review_rounds}.${i + 1}`, severity: String(f?.severity ?? 'medium'), file: f?.file, line: f?.line, note: String(f?.note ?? ''), status: 'open' })),
    at: new Date().toISOString(),
  }
  logEvent(state, 'review', `${state.review.verdict} with ${state.review.findings.length} finding(s)`)
  await saveState(ctx.root, ctx.env, state)
  return PASS
}

/**
 * Re-injects the loop state after a resume or compaction.
 * @param {Ctx} ctx
 * @returns {Promise<HookResult>}
 */
export async function sessionStart(ctx) {
  if (ctx.tampered) return context('SessionStart', `seaworthy: session state tampered (${ctx.tampered}); git writes are frozen until the developer runs \`seaworthy stop\`.`)
  if (!ctx.state || isTerminal(ctx.state.phase)) return PASS
  const s = ctx.state
  const lines = [
    `seaworthy session in progress (phase ${s.phase}, autonomy ${s.autonomy}).`,
    `Task: ${s.task || 'finish the existing uncommitted work'}.`,
    `Checks: ${Object.entries(s.checks).map(([t, r]) => `${t} ${r?.ok ? 'green' : `red (${r?.failed.join(', ')})`}`).join('; ') || 'not run yet'}.`,
    `Review: ${s.review ? `${s.review.verdict}, ${s.review.findings.filter((f) => f.status === 'open').length} open` : 'none yet'}. CI cycles: ${s.ci.cycles}.`,
  ]
  if (ctx.input.session_id && s.session_id !== ctx.input.session_id) lines.push('This is a different Claude Code session: the developer must type /seaworthy:ship to continue it.')
  return context('SessionStart', lines.join(' '))
}

/** @type {Record<string, (ctx: Ctx) => Promise<HookResult>>} */
export const HANDLERS = {
  'user-prompt-submit': userPromptSubmit,
  'pre-tool-use': preToolUse,
  'post-tool-use': postToolUse,
  stop,
  'subagent-stop': subagentStop,
  'session-start': sessionStart,
}

