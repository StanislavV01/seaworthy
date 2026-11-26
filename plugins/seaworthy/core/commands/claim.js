// @ts-check
import { parseArgs } from '../args.js'
import { loadConfig } from '../config.js'
import { isGitRepo, topLevel } from '../git.js'
import { startOrResume } from '../session.js'
import { loadState, TamperError } from '../state.js'

/**
 * `seaworthy claim --session <id> [-- task words…]`: starts or resumes a session.
 * Run by Claude Code itself when the developer invokes /seaworthy:ship (the skill injects it
 * before the model sees the prompt). The agent cannot run it: the PreToolUse hook refuses it.
 * Always exits 0 and prints a message for the model.
 * @type {import('../cli.js').Command}
 */
export async function run(args, io) {
  const { flags, positionals } = parseArgs(args, ['session'])
  const sessionId = typeof flags.session === 'string' ? flags.session : ''
  const raw = [positionals.join(' '), flags.auto ? '--auto' : '', flags.careful ? '--careful' : ''].join(' ')
  if (!(await isGitRepo(io.cwd))) {
    io.stdout.write('seaworthy: not a git repository; the loop cannot run here.\n')
    return 0
  }
  const root = await topLevel(io.cwd)
  const cfg = await loadConfig(root).catch(() => null)
  if (!cfg) {
    io.stdout.write('seaworthy: no .seaworthy.json in this repository. Tell the developer to run /seaworthy:init first; do not start the loop.\n')
    return 0
  }
  if (!sessionId || sessionId.includes('${')) {
    io.stdout.write('seaworthy: no Claude Code session id was provided; the session will be claimed by the UserPromptSubmit hook instead.\n')
    return 0
  }
  try {
    const state = await loadState(root, io.env)
    io.stdout.write((await startOrResume({ root, env: io.env, cfg, state, sessionId, raw })) + '\n')
  } catch (err) {
    if (!(err instanceof TamperError)) throw err
    io.stdout.write(`seaworthy: the session state was tampered with (${err.message}). Do not continue; tell the developer to run \`seaworthy stop\` in their own terminal.\n`)
  }
  return 0
}
