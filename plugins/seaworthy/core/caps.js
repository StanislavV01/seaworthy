// @ts-check
import { createHash } from 'node:crypto'

/**
 * @typedef {{ action: 'fix' | 'rerun' | 'escalate' | 'wait', reason: string }} NextAction
 */

/**
 * A stable fingerprint of a failure, insensitive to timestamps, durations, line numbers in
 * stack traces and temp paths, so "the same failure again" can be recognised.
 * @param {string} text error lines
 */
export function failureSignature(text) {
  const norm = text
    .split('\n')
    .map((l) =>
      l
        .replace(/^\S+\t\S+\t/, '')
        .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z\s*/g, '')
        .replace(/\/tmp\/\S+|\/home\/runner\/\S+|[A-Z]:\\\S+/g, '<path>')
        .replace(/\b\d+(\.\d+)?\s*(ms|s|m)\b/g, '<t>')
        .replace(/:\d+:\d+/g, ':<l>')
        .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 30)
    .join('\n')
  return createHash('sha1').update(norm).digest('hex').slice(0, 12)
}

/**
 * Decides what the loop does after a CI failure, encoding every cap from the design.
 * Mutates the state's counters.
 * @param {import('./state.js').State} state
 * @param {import('./config.js').Caps} caps
 * @param {{ sha: string, signature: string, testOnly: boolean }} f
 * @returns {NextAction}
 */
export function afterCiFailure(state, caps, f) {
  const sigs = state.counters.signatures
  const seen = sigs.filter((s) => s === f.signature).length
  const oscillating = sigs.length >= 2 && sigs[sigs.length - 2] === f.signature && sigs[sigs.length - 1] !== f.signature
  sigs.push(f.signature)
  if (sigs.length > 50) sigs.splice(0, sigs.length - 50)

  if (seen === 0 && f.testOnly && (state.ci.reruns[f.sha] ?? 0) < caps.flakyRerunsPerSha) {
    state.ci.reruns[f.sha] = (state.ci.reruns[f.sha] ?? 0) + 1
    return { action: 'rerun', reason: 'first time this test failure is seen: rerunning once to rule out a flaky test' }
  }
  if (seen >= caps.sameSignature) return { action: 'escalate', reason: `the same CI failure happened ${seen + 1} times` }
  if (oscillating) return { action: 'escalate', reason: 'fixes are oscillating between two failures (A → B → A)' }
  if (state.ci.cycles >= caps.ciCycles) return { action: 'escalate', reason: `CI still failing after ${state.ci.cycles} fix cycles (cap ${caps.ciCycles})` }
  return { action: 'fix', reason: `CI failed (cycle ${state.ci.cycles + 1} of ${caps.ciCycles}): read \`seaworthy ci excerpt\`, fix locally, re-run checks, commit, push` }
}

/**
 * After a local check failure.
 * @param {import('./state.js').State} state
 * @param {import('./config.js').Caps} caps
 * @param {string[]} failed
 * @returns {NextAction}
 */
export function afterCheckFailure(state, caps, failed) {
  const over = failed.filter((id) => (state.counters.fix_attempts[id] ?? 0) > caps.fixAttemptsPerCheck)
  if (over.length) return { action: 'escalate', reason: `${over.join(', ')} still failing after ${caps.fixAttemptsPerCheck} fix attempts` }
  return { action: 'fix', reason: `fix ${failed.join(', ')} and run the checks again` }
}
