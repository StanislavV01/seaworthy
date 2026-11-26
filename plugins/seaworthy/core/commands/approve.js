// @ts-check
import { parseArgs } from '../args.js'
import { logEvent, updateState } from '../state.js'

/**
 * `seaworthy approve <guard-id> [--reason text]` and `seaworthy waive <finding-id> [--reason text]`.
 * Human-only: the PreToolUse hook refuses these when the agent runs them.
 * @type {import('../cli.js').Command}
 */
export async function run(args, io) {
  const { flags, positionals } = parseArgs(args, ['reason'])
  const id = positionals[0]
  const waive = Boolean(flags.waive)
  if (!id) {
    io.stderr.write(`usage: seaworthy ${waive ? 'waive <finding-id>' : 'approve <guard-id>'} [--reason "why"]\n`)
    return 2
  }
  const reason = typeof flags.reason === 'string' ? flags.reason : 'approved by the developer'
  const res = await updateState(io.cwd, io.env, (s) => {
    if (waive) {
      const f = s.review?.findings.find((x) => x.id === id)
      if (!f) return false
      f.status = 'waived'
      f.waiver = reason
      if (s.review && s.review.findings.every((x) => x.status !== 'open' || x.severity === 'low')) s.review.verdict = 'approve'
    } else {
      s.approvals[id] = { reason, at: new Date().toISOString(), by: 'human' }
      delete s.approval_requests[id]
    }
    logEvent(s, waive ? 'waive' : 'approve', `${id}: ${reason}`)
    return true
  })
  if (!res) {
    io.stderr.write('no active seaworthy session in this worktree\n')
    return 1
  }
  if (res.result === false) {
    io.stderr.write(`no review finding ${id}\n`)
    return 1
  }
  io.stdout.write(`${waive ? 'waived' : 'approved'} ${id}\n`)
  return 0
}
