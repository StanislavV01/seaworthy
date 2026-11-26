// @ts-check
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canonicalJson } from './config.js'
import { gitDir } from './git.js'
import { getKey, markerPath, sign, verify } from './integrity.js'

/**
 * @typedef {'implement' | 'checks' | 'review' | 'commit' | 'push' | 'ci' | 'waiting_ci' | 'report' | 'done' | 'escalated' | 'stopped'} Phase
 * @typedef {'fast' | 'commit' | 'push'} Tier
 * @typedef {{ tree: string, ok: boolean, failed: string[], at: string, logs?: Record<string, string> }} CheckResult
 * @typedef {{ id: string, severity: string, file?: string, line?: number, note: string, status: 'open' | 'fixed' | 'waived', waiver?: string }} Finding
 * @typedef {{ tree: string, verdict: 'approve' | 'changes_requested', findings: Finding[], at: string }} Review
 * @typedef {{ id: number, sha: string, conclusion: string, signature?: string, url?: string }} CiRun
 * @typedef {{
 *   version: 1,
 *   session_id: string,
 *   phase: Phase,
 *   task: string,
 *   autonomy: import('./config.js').Autonomy,
 *   branch: string | null,
 *   base_sha: string | null,
 *   start_tree: string,
 *   config_hash: string,
 *   started_at: string,
 *   updated_at: string,
 *   checks: Partial<Record<Tier, CheckResult>>,
 *   review: Review | null,
 *   review_rounds: number,
 *   approvals: Record<string, { reason: string, at: string, by: 'human' }>,
 *   approval_requests: Record<string, { at: string }>,
 *   force_push_allowed: boolean,
 *   commits: { sha: string, subject: string }[],
 *   ci: { sha: string | null, pr_url: string | null, runs: CiRun[], cycles: number, reruns: Record<string, number>, waited_ms: number, started_waiting_at: string | null },
 *   counters: { fix_attempts: Record<string, number>, stop_blocks: number, signatures: string[] },
 *   escalation: string | null,
 *   events: { at: string, type: string, detail: string }[]
 * }} State
 */

export class TamperError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'TamperError'
  }
}

/** @param {string} cwd */
export async function statePaths(cwd) {
  const dir = join(await gitDir(cwd), 'seaworthy')
  return { dir, file: join(dir, 'state.json'), runs: join(dir, 'runs') }
}

/**
 * @param {{ sessionId: string, task: string, autonomy: import('./config.js').Autonomy, branch: string | null, baseSha: string | null, startTree: string, configHash: string }} p
 * @returns {State}
 */
export function newState(p) {
  const now = new Date().toISOString()
  return {
    version: 1,
    session_id: p.sessionId,
    phase: 'implement',
    task: p.task,
    autonomy: p.autonomy,
    branch: p.branch,
    base_sha: p.baseSha,
    start_tree: p.startTree,
    config_hash: p.configHash,
    started_at: now,
    updated_at: now,
    checks: {},
    review: null,
    review_rounds: 0,
    approvals: {},
    approval_requests: {},
    force_push_allowed: false,
    commits: [],
    ci: { sha: null, pr_url: null, runs: [], cycles: 0, reruns: {}, waited_ms: 0, started_waiting_at: null },
    counters: { fix_attempts: {}, stop_blocks: 0, signatures: [] },
    escalation: null,
    events: [],
  }
}

/**
 * Loads and verifies the session state.
 * Returns null when no session exists. Throws TamperError when the state was edited, replaced
 * by an older copy, or deleted while the out-of-repo marker says a session is active.
 * @param {string} cwd
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<State | null>}
 */
export async function loadState(cwd, env) {
  const { file } = await statePaths(cwd)
  const marker = markerPath(env, await gitDir(cwd))
  const hasMarker = existsSync(marker)
  if (!existsSync(file)) {
    if (hasMarker) throw new TamperError('session state is missing while a session is active')
    return null
  }
  const key = await getKey(env)
  /** @type {{ state: State, hmac: string }} */
  let wrapped
  try {
    wrapped = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    throw new TamperError('session state is not valid JSON')
  }
  if (!wrapped || typeof wrapped !== 'object' || !wrapped.state || !verify(key, canonicalJson(wrapped.state), wrapped.hmac))
    throw new TamperError('session state signature does not match')
  if (!hasMarker) throw new TamperError('session state exists without its marker')
  const m = JSON.parse(await readFile(marker, 'utf8'))
  if (m.hmac !== wrapped.hmac) throw new TamperError('session state was replaced by a different copy')
  return wrapped.state
}

/**
 * @param {string} cwd
 * @param {Record<string, string | undefined>} env
 * @param {State} state
 */
export async function saveState(cwd, env, state) {
  const { file } = await statePaths(cwd)
  const marker = markerPath(env, await gitDir(cwd))
  const key = await getKey(env)
  state.updated_at = new Date().toISOString()
  const hmac = sign(key, canonicalJson(state))
  await mkdir(dirname(file), { recursive: true })
  await mkdir(dirname(marker), { recursive: true, mode: 0o700 })
  const tmpFile = `${file}.${process.pid}.tmp`
  await writeFile(tmpFile, JSON.stringify({ state, hmac }, null, 2) + '\n')
  await rename(tmpFile, file)
  await writeFile(marker, JSON.stringify({ session_id: state.session_id, hmac }) + '\n', { mode: 0o600 })
}

/**
 * Load, change, save. The mutator may return a value.
 * @template T
 * @param {string} cwd
 * @param {Record<string, string | undefined>} env
 * @param {(s: State) => T} mutate
 * @returns {Promise<{ state: State, result: T } | null>}
 */
export async function updateState(cwd, env, mutate) {
  const state = await loadState(cwd, env)
  if (!state) return null
  const result = mutate(state)
  await saveState(cwd, env, state)
  return { state, result }
}

/**
 * Ends the session: removes state and marker (human-only via the CLI).
 * @param {string} cwd
 * @param {Record<string, string | undefined>} env
 */
export async function clearState(cwd, env) {
  const { file } = await statePaths(cwd)
  await rm(file, { force: true })
  await rm(markerPath(env, await gitDir(cwd)), { force: true })
}

/**
 * @param {State} s
 * @param {string} type
 * @param {string} detail
 */
export function logEvent(s, type, detail) {
  s.events.push({ at: new Date().toISOString(), type, detail })
  if (s.events.length > 200) s.events.splice(0, s.events.length - 200)
}

/** @param {Phase} p */
export const isTerminal = (p) => p === 'done' || p === 'escalated' || p === 'stopped' || p === 'waiting_ci'
