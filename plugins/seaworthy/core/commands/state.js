// @ts-check
import { parseArgs, writeJson } from '../args.js'
import { loadState, TamperError } from '../state.js'

/**
 * `seaworthy state [--json]`: prints the raw session state.
 * @type {import('../cli.js').Command}
 */
export async function run(args, io) {
  const { flags } = parseArgs(args)
  try {
    const s = await loadState(io.cwd, io.env)
    if (!s) {
      if (flags.json) io.stdout.write('null\n')
      else io.stderr.write('no seaworthy session in this worktree\n')
      return flags.json ? 0 : 1
    }
    writeJson(io.stdout, s)
    return 0
  } catch (err) {
    if (err instanceof TamperError) {
      io.stderr.write(`state tampered: ${err.message}\n`)
      return 3
    }
    throw err
  }
}
