// @ts-check
import { logEvent, updateState } from '../state.js'

/**
 * `seaworthy allow-force-push`: lets the session push once with --force-with-lease. Developer only.
 * @type {import('../cli.js').Command}
 */
export async function run(_args, io) {
  const res = await updateState(io.cwd, io.env, (s) => {
    s.force_push_allowed = true
    logEvent(s, 'allow-force-push', 'developer allowed one --force-with-lease push')
  })
  if (!res) {
    io.stderr.write('no active seaworthy session in this worktree\n')
    return 1
  }
  io.stdout.write('one --force-with-lease push is allowed for this session\n')
  return 0
}
