// @ts-check
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { topLevel, treeFingerprint } from './git.js'
import { logEvent, statePaths } from './state.js'

/**
 * @typedef {{ tier: import('./state.js').Tier, tree: string, ok: boolean, failed: string[], logs: Record<string, string>, ran: string[] }} TierResult
 */

/**
 * Runs a command line through the platform shell and captures combined output.
 * @param {string} cmdline
 * @param {string} cwd
 * @param {number} timeoutMs
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<{ code: number, output: string, timedOut: boolean }>}
 */
export function runShell(cmdline, cwd, timeoutMs, env) {
  return new Promise((resolve) => {
    const child = spawn(cmdline, { cwd, shell: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: 127, output: output + String(err.message), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: timedOut ? 124 : (code ?? 1), output, timedOut })
    })
  })
}

/** @param {string} p */
const shellQuote = (p) => (/^[\w./@:+-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`)

/**
 * Runs every check of a tier. The result is bound to the working-tree fingerprint taken before
 * the run; if the checks themselves change the tree (formatters, codegen), the run is not green.
 * @param {string} cwd
 * @param {import('./state.js').Tier} tier
 * @param {{ timeoutMs?: number, only?: string[] }} [opts]
 * @returns {Promise<TierResult>}
 */
export async function runTier(cwd, tier, opts = {}) {
  const root = await topLevel(cwd)
  const cfg = await loadConfig(root)
  if (!cfg) throw new Error('no .seaworthy.json here; run `seaworthy init --yes` first')
  const ids = cfg.tiers[tier].filter((id) => !opts.only || opts.only.includes(id))
  const timeoutMs = opts.timeoutMs ?? cfg.caps.checkTimeoutSec * 1000
  const tree = await treeFingerprint(root)
  const { runs } = await statePaths(root)
  await mkdir(runs, { recursive: true })
  /** @type {string[]} */
  const failed = []
  /** @type {Record<string, string>} */
  const logs = {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const id of ids) {
    const check = cfg.checks.find((c) => c.id === id)
    if (!check) continue
    const r = await runShell(check.cmd, root, timeoutMs)
    const log = join(runs, `${stamp}-${tier}-${id}.log`)
    await writeFile(log, `$ ${check.cmd}\n${r.output}\n[exit ${r.code}${r.timedOut ? ', timeout' : ''}]\n`)
    logs[id] = log
    if (r.code !== 0) failed.push(r.timedOut ? `${id} (timeout)` : id)
  }
  const after = await treeFingerprint(root)
  if (after !== tree) failed.push('tree changed during checks')
  return { tier, tree, ok: failed.length === 0, failed, logs, ran: ids }
}

/**
 * Lints only the given files with the lint check's per-file command, if it has one.
 * @param {string} cwd
 * @param {string[]} files
 * @returns {Promise<{ ran: boolean, ok: boolean, output: string }>}
 */
export async function lintFiles(cwd, files) {
  const root = await topLevel(cwd)
  const cfg = await loadConfig(root)
  const lint = cfg?.checks.find((c) => c.id === 'lint')
  if (!cfg || !lint?.perFile || files.length === 0) return { ran: false, ok: true, output: '' }
  const cmd = lint.perFile.replace('{files}', files.map(shellQuote).join(' '))
  const r = await runShell(cmd, root, Math.min(cfg.caps.checkTimeoutSec, 60) * 1000)
  return { ran: true, ok: r.code === 0, output: r.output }
}

/**
 * Is the tier green for exactly this tree? A passing push tier also covers commit and fast,
 * and a passing commit tier covers fast.
 * @param {import('./state.js').State} state
 * @param {import('./state.js').Tier} tier
 * @param {string} tree
 * @param {import('./config.js').Config} [cfg] when given, a tier with no checks counts as green
 */
export function isGreen(state, tier, tree, cfg) {
  if (cfg && cfg.tiers[tier].length === 0) return true
  /** @type {import('./state.js').Tier[]} */
  const covering = tier === 'fast' ? ['fast', 'commit', 'push'] : tier === 'commit' ? ['commit', 'push'] : ['push']
  return covering.some((t) => {
    const r = state.checks[t]
    return Boolean(r && r.ok && r.tree === tree)
  })
}

/**
 * Records a tier result in the session state and counts fix attempts per failing check.
 * @param {import('./state.js').State} state
 * @param {TierResult} r
 */
export function recordResult(state, r) {
  state.checks[r.tier] = { tree: r.tree, ok: r.ok, failed: r.failed, at: new Date().toISOString(), logs: r.logs }
  for (const id of r.failed) state.counters.fix_attempts[id] = (state.counters.fix_attempts[id] ?? 0) + 1
  logEvent(state, 'checks', `${r.tier}: ${r.ok ? 'green' : `red (${r.failed.join(', ')})`}`)
}
