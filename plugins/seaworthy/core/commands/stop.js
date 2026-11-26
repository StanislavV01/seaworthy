// @ts-check
import { clearState, loadState, TamperError } from '../state.js'

/**
 * `seaworthy stop`: ends the session in this worktree and switches every gate off.
 * Human-only. Also the way out of a tampered (frozen) session.
 * @type {import('../cli.js').Command}
 */
export async function run(_args, io) {
  let note = ''
  try {
    const s = await loadState(io.cwd, io.env)
    if (!s) note = ' (there was no session)'
  } catch (err) {
    if (err instanceof TamperError) note = ` (the state was tampered: ${err.message})`
    else throw err
  }
  await clearState(io.cwd, io.env)
  io.stdout.write(`seaworthy session stopped${note}. Gates are off in this worktree.\n`)
  return 0
}
