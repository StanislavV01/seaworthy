// @ts-check
import { parseArgs } from '../args.js'
import { logEvent, updateState } from '../state.js'

/**
 * `seaworthy request-approval <id>`: the agent's way to ask. Claude Code shows the developer a
 * permission prompt (the PreToolUse hook answers "ask" with the exact guard item); the command
 * only runs, and the approval is only recorded, if the developer allows it.
 * @type {import('../cli.js').Command}
 */
export async function run(args, io) {
  const { positionals } = parseArgs(args)
  const id = positionals[0]
  if (!id) {
    io.stderr.write('usage: seaworthy request-approval <guard-id | finding-id>\n')
    return 2
  }
  const res = await updateState(io.cwd, io.env, (s) => {
    const finding = s.review?.findings.find((f) => f.id === id)
    if (finding) {
      finding.status = 'waived'
      finding.waiver = 'approved by the developer at the permission prompt'
      if (s.review && s.review.findings.every((f) => f.status !== 'open' || f.severity === 'low')) s.review.verdict = 'approve'
    } else {
      s.approvals[id] = { reason: 'approved by the developer at the permission prompt', at: new Date().toISOString(), by: 'human' }
      delete s.approval_requests[id]
    }
    logEvent(s, 'approve', `${id} via permission prompt`)
  })
  if (!res) {
    io.stderr.write('no active seaworthy session in this worktree\n')
    return 1
  }
  io.stdout.write(`approved ${id}\n`)
  return 0
}
