// @ts-check
import { parseArgs, writeJson } from '../args.js'
import { recordResult, runTier } from '../checks.js'
import { loadState, saveState, TamperError } from '../state.js'

/**
 * `seaworthy check [--tier fast|commit|push] [--json]`. Exit 0 when green, 1 when red.
 * @type {import('../cli.js').Command}
 */
export async function run(args, io) {
  const { flags } = parseArgs(args, ['tier'])
  const tier = /** @type {import('../state.js').Tier} */ (String(flags.tier || 'commit'))
  if (!['fast', 'commit', 'push'].includes(tier)) {
    io.stderr.write(`unknown tier "${tier}" (fast, commit, push)\n`)
    return 2
  }
  const r = await runTier(io.cwd, tier)
  /** @type {import('../state.js').State | null} */
  let state = null
  try {
    state = await loadState(io.cwd, io.env)
  } catch (err) {
    if (!(err instanceof TamperError)) throw err
  }
  if (state) {
    recordResult(state, r)
    if (state.phase === 'implement' || state.phase === 'checks') state.phase = r.ok ? 'review' : 'checks'
    await saveState(io.cwd, io.env, state)
  }
  if (flags.json) writeJson(io.stdout, r)
  else {
    io.stdout.write(`${r.tier}: ${r.ok ? 'green' : 'red'} (${r.ran.join(', ') || 'no checks'})\n`)
    for (const f of r.failed) io.stdout.write(`  ✗ ${f}${r.logs[f] ? `  log: ${r.logs[f]}` : ''}\n`)
  }
  return r.ok ? 0 : 1
}
