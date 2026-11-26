// @ts-check
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { lastResults } from './checks.js'
import { gitHooksInstalled } from './git-hooks.js'
import { headSha, isGitRepo, topLevel, treeFingerprint } from './git.js'
import { openEvents, scanGuard } from './guard.js'
import { loadState, TamperError } from './state.js'

/**
 * @typedef {'green' | 'red' | 'stale' | 'none'} TierStatus
 * @typedef {{
 *   tracked: boolean,
 *   session: boolean,
 *   tampered: string | null,
 *   phase: string | null,
 *   task: string | null,
 *   branch: string | null,
 *   checks: Record<'fast' | 'commit' | 'push', TierStatus>,
 *   failed: string[],
 *   guard: { open: number, ids: string[] },
 *   review: 'approve' | 'changes_requested' | 'stale' | 'none',
 *   ci: { status: string, prUrl: string | null, cycles: number },
 *   gitHooks: boolean,
 *   escalation: string | null,
 *   updatedAt: string | null,
 * }} StatusJson
 */

/**
 * @param {import('./state.js').State | null} state
 * @param {'fast' | 'commit' | 'push'} tier
 * @param {string} tree
 * @returns {TierStatus}
 */
function tierStatus(state, tier, tree) {
  const r = state?.checks[tier]
  if (!r) return 'none'
  if (r.tree !== tree) return 'stale'
  return r.ok ? 'green' : 'red'
}

/**
 * One status shape for humans, the status line and the Orca panel.
 * @param {string} cwd
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<StatusJson>}
 */
export async function statusJson(cwd, env) {
  /** @type {StatusJson} */
  const st = {
    tracked: false,
    session: false,
    tampered: null,
    phase: null,
    task: null,
    branch: null,
    checks: { fast: 'none', commit: 'none', push: 'none' },
    failed: [],
    guard: { open: 0, ids: [] },
    review: 'none',
    ci: { status: 'none', prUrl: null, cycles: 0 },
    gitHooks: false,
    escalation: null,
    updatedAt: null,
  }
  if (!(await isGitRepo(cwd))) return st
  const root = await topLevel(cwd)
  st.tracked = existsSync(join(root, '.seaworthy.json'))
  if (!st.tracked) return st
  st.gitHooks = await gitHooksInstalled(root).catch(() => false)
  /** @type {import('./state.js').State | null} */
  let state = null
  try {
    state = await loadState(root, env)
  } catch (err) {
    if (err instanceof TamperError) st.tampered = err.message
    else throw err
  }
  const tree = await treeFingerprint(root)
  if (!state) {
    const last = await lastResults(root)
    /** @type {any} */
    const pseudo = { checks: last }
    st.checks = { fast: tierStatus(pseudo, 'fast', tree), commit: tierStatus(pseudo, 'commit', tree), push: tierStatus(pseudo, 'push', tree) }
    st.failed = [...new Set([...(last.push?.tree === tree ? last.push.failed : []), ...(last.commit?.tree === tree ? last.commit.failed : [])])]
    return st
  }
  st.session = true
  st.phase = state.phase
  st.task = state.task
  st.branch = state.branch
  st.updatedAt = state.updated_at
  st.escalation = state.escalation
  st.checks = { fast: tierStatus(state, 'fast', tree), commit: tierStatus(state, 'commit', tree), push: tierStatus(state, 'push', tree) }
  st.failed = [...new Set([...(state.checks.push?.tree === tree ? state.checks.push.failed : []), ...(state.checks.commit?.tree === tree ? state.checks.commit.failed : [])])]
  const open = openEvents(await scanGuard(root, state.start_tree), state.approvals)
  st.guard = { open: open.length, ids: open.map((e) => e.id) }
  st.review = !state.review ? 'none' : state.review.tree !== tree ? 'stale' : state.review.verdict
  const sha = await headSha(root)
  const last = state.ci.runs.filter((r) => r.sha === sha).at(-1)
  st.ci = { status: state.ci.sha !== sha ? 'not pushed' : last ? last.conclusion : 'waiting', prUrl: state.ci.pr_url, cycles: state.ci.cycles }
  return st
}

/**
 * e.g. `seaworthy ▸ checks ✓✓✗ (test 2/3) · review — · CI —`
 * @param {StatusJson} st
 * @param {import('./config.js').Config | null} cfg
 * @param {import('./state.js').State | null} [state]
 */
export function statusLine(st, cfg, state) {
  if (!st.tracked) return ''
  if (st.tampered) return 'seaworthy ▸ ⚠ state tampered — run `seaworthy stop`'
  if (!st.session) return 'seaworthy ▸ idle'
  const ids = cfg?.tiers.push ?? []
  const marks = ids
    .map((id) => {
      if (st.failed.includes(id) || st.failed.includes(`${id} (timeout)`)) return '✗'
      const ranFor = (/** @type {'fast' | 'commit' | 'push'} */ t) => (st.checks[t] === 'green' || st.checks[t] === 'red') && Boolean(cfg?.tiers[t].includes(id))
      return ranFor('fast') || ranFor('commit') || ranFor('push') ? '✓' : '·'
    })
    .join('')
  const firstFailed = st.failed[0]?.replace(' (timeout)', '')
  const attempts = firstFailed && state ? ` (${firstFailed} ${state.counters.fix_attempts[firstFailed] ?? 0}/${cfg?.caps.fixAttemptsPerCheck ?? 3})` : ''
  const review = st.review === 'approve' ? '✓' : st.review === 'changes_requested' ? '✗' : '—'
  const ci = st.ci.status === 'success' ? '✓' : st.ci.status === 'failure' ? '✗' : st.ci.status === 'pending' || st.ci.status === 'waiting' ? '…' : '—'
  const guard = st.guard.open ? ` · guard ⚠${st.guard.open}` : ''
  const phase = st.phase === 'escalated' ? ' · ESCALATED' : st.phase === 'done' ? ' · done' : ''
  return `seaworthy ▸ checks ${marks || '—'}${attempts} · review ${review} · CI ${ci}${guard}${phase}`
}

/**
 * The final report. Never claims success that the state does not support.
 * @param {import('./state.js').State} s
 * @param {StatusJson} st
 * @param {{ done: boolean }} opts
 */
export function renderReport(s, st, opts) {
  const ok = opts.done
  const title = ok ? `✅ Shipped: ${s.task || 'existing work'}` : s.phase === 'escalated' ? `⛔ Not shipped (escalated): ${s.task || 'existing work'}` : `⏳ Not finished: ${s.task || 'existing work'}`
  const tierLine = (/** @type {'fast'|'commit'|'push'} */ t) => `${t} ${st.checks[t] === 'green' ? '✓' : st.checks[t] === 'red' ? '✗' : st.checks[t] === 'stale' ? '(stale)' : '—'}`
  /** @type {string[]} */
  const notDone = []
  if (st.checks.commit !== 'green' && st.checks.push !== 'green') notDone.push(`commit checks ${st.checks.commit}${st.failed.length ? ` (${st.failed.join(', ')})` : ''}`)
  if (st.checks.push !== 'green') notDone.push(`push checks ${st.checks.push}`)
  if (st.review !== 'approve') notDone.push(`review ${st.review}`)
  if (st.guard.open) notDone.push(`${st.guard.open} unapproved guard event(s): ${st.guard.ids.join(', ')}`)
  if (st.ci.status !== 'success' && st.ci.status !== 'none') notDone.push(`CI ${st.ci.status}`)
  if (s.escalation) notDone.push(`escalation: ${s.escalation}`)
  const approvals = Object.entries(s.approvals)
  const openFindings = s.review?.findings.filter((f) => f.status === 'open') ?? []
  const flaky = s.events.filter((e) => e.type === 'flaky').map((e) => e.detail)
  const minutes = Math.round((Date.parse(s.updated_at) - Date.parse(s.started_at)) / 60000)
  const md = [
    `## ${title}`,
    '',
    `| | |`,
    `|---|---|`,
    `| Branch | \`${s.branch ?? '(detached)'}\` |`,
    `| Commits | ${s.commits.length ? s.commits.map((c) => `\`${c.sha.slice(0, 7)}\` ${c.subject}`).join('<br>') : '—'} |`,
    `| Checks | ${tierLine('fast')} · ${tierLine('commit')} · ${tierLine('push')} |`,
    `| Review | ${st.review}${openFindings.length ? ` · ${openFindings.length} open finding(s)` : ''} (${s.review_rounds} round(s)) |`,
    `| Guard | ${approvals.length ? approvals.map(([id, a]) => `${id} approved by developer (${a.reason})`).join('<br>') : 'nothing flagged or all reverted'}${st.guard.open ? `<br>⚠ open: ${st.guard.ids.join(', ')}` : ''} |`,
    `| CI | ${st.ci.status}${st.ci.prUrl ? ` · ${st.ci.prUrl}` : ''} · ${s.ci.cycles} fix cycle(s) |`,
    `| Flaky | ${flaky.length ? flaky.join('<br>') : '—'} |`,
    `| Time | ${minutes} min |`,
    '',
    notDone.length ? `**Not done:**\n${notDone.map((n) => `- ${n}`).join('\n')}` : '**Not done:** —',
  ]
  if (openFindings.length) md.push('', '**Open review findings:**', ...openFindings.map((f) => `- ${f.id} [${f.severity}] ${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.note}`))
  return { markdown: md.join('\n') + '\n', json: { done: ok, title, status: st, notDone, approvals: s.approvals, openFindings, flaky } }
}

