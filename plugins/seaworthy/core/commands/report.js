// @ts-check
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs, writeJson } from '../args.js'
import { loadConfig } from '../config.js'
import { git, topLevel } from '../git.js'
import { nextStep } from '../hooks/handlers.js'
import { renderReport, statusJson } from '../report.js'
import { loadState, logEvent, saveState, statePaths } from '../state.js'

/**
 * `seaworthy report [--final] [--json]`. With `--final` the session is marked done only if every
 * gate is actually green; otherwise the report says what is not done.
 * @type {import('../cli.js').Command}
 */
export async function run(args, io) {
  const { flags } = parseArgs(args)
  const root = await topLevel(io.cwd)
  const state = await loadState(root, io.env)
  if (!state) {
    io.stderr.write('no seaworthy session in this worktree\n')
    return 1
  }
  const cfg = await loadConfig(root)
  if (state.base_sha) {
    const log = await git(root, ['log', '--format=%H%x09%s', `${state.base_sha}..HEAD`])
    if (log.code === 0)
      state.commits = log.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .reverse()
        .map((l) => ({ sha: l.split('\t')[0], subject: l.split('\t').slice(1).join('\t') }))
  }
  const remaining = await nextStep({ input: {}, env: io.env, root, state, tampered: null, cfg, active: true, gating: true })
  const st = await statusJson(root, io.env)
  const done = !remaining && (st.ci.status === 'success' || st.ci.status === 'none')
  if (flags.final && done) {
    state.phase = 'done'
    logEvent(state, 'done', 'all gates green')
  }
  const rep = renderReport(state, await statusJson(root, io.env), { done: done && Boolean(flags.final || state.phase === 'done') })
  await saveState(root, io.env, state)
  const { dir } = await statePaths(root)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'report.md'), rep.markdown)
  if (flags.json) writeJson(io.stdout, { ...rep.json, next: remaining })
  else io.stdout.write(rep.markdown + (remaining && !done ? `\nNext: ${remaining}\n` : ''))
  return done ? 0 : 1
}
