// @ts-check
import { join } from 'node:path'
import { main } from '../../plugins/seaworthy/core/cli.js'
import { captureIO, repo, sh, tmp } from '../helpers.js'

export const SID = 'session-1'

const CFG = {
  version: 1,
  packageManager: 'npm',
  checks: [
    { id: 'lint', cmd: 'true', script: 'lint' },
    { id: 'test', cmd: 'grep -q ok src/a.txt', script: 'test' },
    { id: 'build', cmd: 'true', script: 'build' },
  ],
  tiers: { fast: ['lint'], commit: ['lint', 'test'], push: ['lint', 'test', 'build'] },
  caps: {},
  autonomy: 'normal',
  allowedTrailers: [],
}

/** A repo with seaworthy configured, on a feature branch, plus a fixed key dir. */
export function setup(cfg = CFG) {
  const dir = repo({
    '.seaworthy.json': JSON.stringify(cfg),
    'src/a.txt': 'ok\n',
    'src/a.test.js': "it('a', () => {})\nit('b', () => {})\n",
    '.gitignore': 'node_modules\n',
  })
  sh(dir, ['git', 'checkout', '-q', '-b', 'feat/x'])
  const env = { SEAWORTHY_KEY_DIR: join(tmp(), 'key') }
  /**
   * @param {string} name
   * @param {object} input
   */
  const hook = async (name, input) => {
    const c = captureIO(dir, JSON.stringify({ session_id: SID, cwd: dir, ...input }), env)
    const code = await main(['hook', name], c.io)
    const out = c.out().trim()
    return { code, out, json: out ? JSON.parse(out) : null, err: c.err() }
  }
  /** @param {string[]} args */
  const cli = async (args) => {
    const c = captureIO(dir, '', env)
    const code = await main(args, c.io)
    return { code, out: c.out(), err: c.err() }
  }
  const bash = (/** @type {string} */ command) => hook('pre-tool-use', { tool_name: 'Bash', tool_input: { command } })
  const start = (prompt = '/seaworthy:ship add a feature') => hook('user-prompt-submit', { prompt })
  const approve = async () => {
    await hook('subagent-start', { agent_type: 'seaworthy:reviewer' })
    return hook('subagent-stop', { agent_type: 'seaworthy:reviewer', last_assistant_message: 'Looks good.\n```json\n{"verdict":"approve","findings":[]}\n```' })
  }
  return { dir, env, hook, cli, bash, start, approve }
}

/** @param {{ json: any }} r */
export const decision = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? null
/** @param {{ json: any }} r */
export const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason ?? r.json?.reason ?? ''
