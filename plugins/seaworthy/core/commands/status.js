// @ts-check
import { parseArgs, writeJson } from '../args.js'
import { loadConfig } from '../config.js'
import { isGitRepo, topLevel } from '../git.js'
import { statusJson, statusLine } from '../report.js'
import { loadState } from '../state.js'

/**
 * `seaworthy status [--json | --line]`. `--line` prints one line for a status bar and never fails.
 * @type {import('../cli.js').Command}
 */
export async function run(args, io) {
  const { flags } = parseArgs(args)
  try {
    const st = await statusJson(io.cwd, io.env)
    if (flags.json) {
      writeJson(io.stdout, st)
      return 0
    }
    const root = (await isGitRepo(io.cwd)) ? await topLevel(io.cwd) : io.cwd
    const cfg = await loadConfig(root).catch(() => null)
    const state = st.session && !st.tampered ? await loadState(root, io.env).catch(() => null) : null
    const line = statusLine(st, cfg, state)
    if (flags.line) {
      io.stdout.write(line + '\n')
      return 0
    }
    if (!st.tracked) {
      io.stdout.write('seaworthy is not set up here (run `seaworthy init`)\n')
      return 0
    }
    io.stdout.write(`${line}\n`)
    if (st.session) {
      io.stdout.write(`phase: ${st.phase}  task: ${st.task || '(existing work)'}  branch: ${st.branch ?? '-'}\n`)
      io.stdout.write(`checks: fast ${st.checks.fast}, commit ${st.checks.commit}, push ${st.checks.push}${st.failed.length ? ` (failed: ${st.failed.join(', ')})` : ''}\n`)
      io.stdout.write(`review: ${st.review}  guard: ${st.guard.open ? `${st.guard.open} open (${st.guard.ids.join(', ')})` : 'clear'}  CI: ${st.ci.status}${st.ci.prUrl ? ` ${st.ci.prUrl}` : ''}\n`)
      if (st.escalation) io.stdout.write(`escalation: ${st.escalation}\n`)
    }
    if (!st.gitHooks) io.stdout.write('note: seaworthy git hooks are not installed (run `seaworthy init --yes --force` to reinstall)\n')
    return 0
  } catch (err) {
    if (flags.line) {
      io.stdout.write('seaworthy ▸ ?\n')
      return 0
    }
    throw err
  }
}
