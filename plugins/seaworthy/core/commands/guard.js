// @ts-check
import { parseArgs, writeJson } from '../args.js'
import { git } from '../git.js'
import { openEvents, scanGuard } from '../guard.js'
import { loadState } from '../state.js'

/**
 * `seaworthy guard [--json]`: guard events since the session started (or since HEAD without a
 * session). Exit 1 while any event is unapproved.
 * @type {import('../cli.js').Command}
 */
export async function run(args, io) {
  const { flags } = parseArgs(args)
  const state = await loadState(io.cwd, io.env)
  let base = state?.start_tree
  if (!base) {
    const r = await git(io.cwd, ['rev-parse', '--verify', '-q', 'HEAD^{tree}'])
    base = r.code === 0 ? r.stdout.trim() : '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
  }
  const events = await scanGuard(io.cwd, base)
  const approvals = state?.approvals ?? {}
  const open = openEvents(events, approvals)
  if (flags.json) writeJson(io.stdout, { events: events.map((e) => ({ ...e, approved: Boolean(approvals[e.id]) })), open: open.length })
  else if (events.length === 0) io.stdout.write('guard: nothing flagged\n')
  else
    for (const e of events)
      io.stdout.write(`${approvals[e.id] ? '✓ approved' : '✗ open    '}  ${e.id}  ${e.type}  ${e.path}  (${e.detail})\n`)
  return open.length ? 1 : 0
}
