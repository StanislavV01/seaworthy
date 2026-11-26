// @ts-check
import { exec } from './git.js'
import { redact } from './redact.js'
import { failureSignature } from './caps.js'

/**
 * @typedef {{ databaseId: number, status: string, conclusion: string, workflowName: string, url: string, event?: string }} GhRun
 * @typedef {{ status: 'success' | 'failure' | 'pending' | 'none', runs: GhRun[] }} RunsStatus
 */

export class GhUnavailable extends Error {}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 * @param {number} [timeoutMs]
 */
export async function gh(cwd, args, env, timeoutMs) {
  const r = await exec('gh', args, { cwd, env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1', ...env }, timeoutMs })
  if (r.code === 127 && /ENOENT|not found/i.test(r.stderr)) throw new GhUnavailable('gh (GitHub CLI) is not installed')
  if (r.code !== 0 && /gh auth login|authentication|not logged in/i.test(r.stderr)) throw new GhUnavailable('gh is not authenticated (run `gh auth login`)')
  return r
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * All workflow runs GitHub started for a commit.
 * @param {string} cwd
 * @param {string} sha
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<GhRun[]>}
 */
export async function listRuns(cwd, sha, env) {
  const r = await gh(cwd, ['run', 'list', '--commit', sha, '--limit', '20', '--json', 'databaseId,status,conclusion,workflowName,url,event'], env)
  if (r.code !== 0) throw new GhUnavailable(`gh run list failed: ${r.stderr.trim()}`)
  return JSON.parse(r.stdout || '[]')
}

/** @param {GhRun[]} runs @returns {RunsStatus['status']} */
export function summarize(runs) {
  if (runs.length === 0) return 'none'
  if (runs.some((r) => r.status !== 'completed')) return 'pending'
  return runs.every((r) => ['success', 'skipped', 'neutral'].includes(r.conclusion)) ? 'success' : 'failure'
}

/**
 * Waits for runs to appear for `sha`, then for them to finish, within `maxMs`.
 * Uses `gh run watch` (no polling cost) and falls back to polling when watch is unavailable
 * (for example with fine-grained tokens).
 * @param {string} cwd
 * @param {string} sha
 * @param {Record<string, string | undefined>} env
 * @param {{ maxMs: number, discoveryMs: number, pollMs?: number }} opts
 * @returns {Promise<RunsStatus>}
 */
export async function watchRuns(cwd, sha, env, opts) {
  const pollMs = opts.pollMs ?? 15_000
  const deadline = Date.now() + opts.maxMs
  const discoveryDeadline = Date.now() + Math.min(opts.discoveryMs, opts.maxMs)
  let runs = await listRuns(cwd, sha, env)
  while (runs.length === 0 && Date.now() < discoveryDeadline) {
    await sleep(Math.min(pollMs, Math.max(0, discoveryDeadline - Date.now())))
    runs = await listRuns(cwd, sha, env)
  }
  if (runs.length === 0) return { status: 'none', runs }
  let watchWorks = true
  while (summarize(runs) === 'pending' && Date.now() < deadline) {
    const pending = runs.find((r) => r.status !== 'completed')
    if (pending && watchWorks) {
      const left = deadline - Date.now()
      const w = await gh(cwd, ['run', 'watch', String(pending.databaseId), '--exit-status', '--compact', '-i', String(Math.max(1, Math.round(pollMs / 1000)))], env, left)
      if (w.code !== 0 && /not supported|fine-grained|Resource not accessible|HTTP 403/i.test(w.stderr)) watchWorks = false
    } else await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())))
    runs = await listRuns(cwd, sha, env)
  }
  return { status: summarize(runs), runs }
}

/**
 * A bounded, redacted excerpt of the failed jobs' logs, plus a failure signature.
 * @param {string} cwd
 * @param {number} runId
 * @param {Record<string, string | undefined>} env
 * @param {number} maxChars
 * @returns {Promise<{ text: string, signature: string, testOnly: boolean }>}
 */
export async function failureExcerpt(cwd, runId, env, maxChars) {
  const r = await gh(cwd, ['run', 'view', String(runId), '--log-failed'], env)
  const raw = r.code === 0 ? r.stdout : `(could not read logs: ${r.stderr.trim()})`
  const lines = raw.split('\n')
  const ERR = /\b(error|failed|failure|fail|panic|exception|assert|expected|received|cannot|unable|not found|ERR!|TS\d{4})\b|✗|✖|×/i
  /** @type {Set<number>} */
  const keep = new Set()
  lines.forEach((l, i) => {
    if (ERR.test(l)) for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 2); k++) keep.add(k)
  })
  /** @type {Map<string, number[]>} */
  const bySteps = new Map()
  lines.forEach((l, i) => {
    const step = l.split('\t').slice(0, 2).join(' › ')
    if (!bySteps.has(step)) bySteps.set(step, [])
    bySteps.get(step)?.push(i)
  })
  for (const idx of bySteps.values()) for (const i of idx.slice(-15)) keep.add(i)
  const picked = [...keep].sort((a, b) => a - b)
  /** @type {string[]} */
  const out = []
  let prev = -2
  for (const i of picked) {
    if (i !== prev + 1) out.push('…')
    out.push(lines[i].replace(/^([^\t]*)\t([^\t]*)\t\d{4}-\d\d-\d\dT[\d:.]+Z /, '$1 › $2 | '))
    prev = i
  }
  let text = redact(out.join('\n'))
  if (text.length > maxChars) text = text.slice(0, maxChars - 40) + '\n… (excerpt truncated)'
  const errorLines = lines.filter((l) => ERR.test(l)).join('\n')
  const stepNames = [...new Set(lines.filter((l) => l.includes('\t')).map((l) => l.split('\t')[1] ?? ''))].join('\n')
  const testOnly = /\btest\b|vitest|jest|playwright|pytest|go test/i.test(stepNames) && !/\b(lint|tsc|typecheck|type-check|build|compile)\b/i.test(stepNames)
  return { text, signature: failureSignature(errorLines || raw.slice(-2000)), testOnly }
}

/**
 * Makes sure a pull request exists for the branch (draft, filled from commits).
 * @param {string} cwd
 * @param {string} branch
 * @param {string} base
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{ url: string, created: boolean }>}
 */
export async function ensurePr(cwd, branch, base, env) {
  const v = await gh(cwd, ['pr', 'view', branch, '--json', 'url', '-q', '.url'], env)
  if (v.code === 0 && v.stdout.trim()) return { url: v.stdout.trim(), created: false }
  const c = await gh(cwd, ['pr', 'create', '--draft', '--fill', '--base', base, '--head', branch], env)
  if (c.code !== 0) throw new Error(`gh pr create failed: ${c.stderr.trim()}`)
  return { url: c.stdout.trim().split('\n').pop() ?? '', created: true }
}

/**
 * @param {string} cwd
 * @param {number} runId
 * @param {Record<string, string | undefined>} env
 */
export async function rerunFailed(cwd, runId, env) {
  const r = await gh(cwd, ['run', 'rerun', String(runId), '--failed'], env)
  return r.code === 0
}
