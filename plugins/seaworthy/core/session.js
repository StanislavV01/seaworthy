// @ts-check
import { configHash } from './config.js'
import { currentBranch, headSha, treeFingerprint } from './git.js'
import { logEvent, newState, saveState } from './state.js'

/**
 * Parses what the developer typed after `/seaworthy:ship`.
 * @param {string} raw
 * @param {import('./config.js').Autonomy} fallback
 */
export function parseShipArgs(raw, fallback) {
  const autonomy = /(^|\s)--auto\b/.test(raw) ? 'auto' : /(^|\s)--careful\b/.test(raw) ? 'careful' : fallback
  const task = raw.replace(/(^|\s)--(auto|careful)\b/g, ' ').replace(/\s+/g, ' ').trim()
  return { autonomy: /** @type {import('./config.js').Autonomy} */ (autonomy), task }
}

/**
 * Starts a session, or resumes the unfinished one in this worktree without resetting its start
 * snapshot (so re-claiming can never hide earlier guard events). Idempotent for the same session.
 * @param {{ root: string, env: Record<string, string | undefined>, cfg: import('./config.js').Config, state: import('./state.js').State | null, sessionId: string, raw: string }} p
 * @returns {Promise<string>} a message for the model
 */
export async function startOrResume(p) {
  const { autonomy, task } = parseShipArgs(p.raw, p.cfg.autonomy)
  const prev = p.state
  if (prev && !['done', 'stopped', 'escalated'].includes(prev.phase)) {
    if (prev.session_id === p.sessionId && prev.phase !== 'waiting_ci') {
      return `seaworthy: session active (phase ${prev.phase}). Task: ${prev.task || 'finish the existing uncommitted work'}.`
    }
    prev.session_id = p.sessionId
    if (prev.phase === 'waiting_ci') prev.phase = 'ci'
    if (task) prev.task = task
    prev.counters.stop_blocks = 0
    logEvent(prev, 'resume', `resumed in session ${p.sessionId}`)
    await saveState(p.root, p.env, prev)
    return `seaworthy: resumed the session for "${prev.task || '(finish existing work)'}" at phase ${prev.phase}. Continue the loop from there.`
  }
  const state = newState({
    sessionId: p.sessionId,
    task,
    autonomy,
    branch: await currentBranch(p.root),
    baseSha: await headSha(p.root),
    startTree: await treeFingerprint(p.root),
    configHash: configHash(p.cfg),
  })
  logEvent(state, 'start', `autonomy ${autonomy}`)
  await saveState(p.root, p.env, state)
  return `seaworthy: session started (autonomy: ${autonomy}). Task: ${task || 'finish the developer’s existing uncommitted work'}. Gates are active: commits need green \`seaworthy check --tier commit\`, an approved seaworthy:reviewer verdict for the same code, and no open guard events; pushes need \`--tier push\`.`
}
