// @ts-check
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { loadConfig } from '../config.js'
import { git, isGitRepo, topLevel } from '../git.js'
import { keyDir } from '../integrity.js'
import { loadState, TamperError } from '../state.js'

/**
 * @typedef {{
 *   session_id?: string,
 *   cwd?: string,
 *   hook_event_name?: string,
 *   tool_name?: string,
 *   tool_input?: Record<string, any>,
 *   tool_response?: unknown,
 *   prompt?: string,
 *   stop_hook_active?: boolean,
 *   last_assistant_message?: string,
 *   agent_type?: string,
 *   transcript_path?: string,
 *   source?: string,
 * }} HookInput
 * @typedef {{ exitCode: number, stdout?: string, stderr?: string }} HookResult
 * @typedef {{
 *   input: HookInput,
 *   env: Record<string, string | undefined>,
 *   root: string,
 *   state: import('../state.js').State | null,
 *   tampered: string | null,
 *   cfg: import('../config.js').Config | null,
 *   active: boolean,
 *   gating: boolean,
 * }} HookContext
 */

/** @type {HookResult} */
export const PASS = { exitCode: 0 }

/** @param {unknown} obj @returns {HookResult} */
export const json = (obj) => ({ exitCode: 0, stdout: JSON.stringify(obj) })

/** @param {string} reason @returns {HookResult} */
export const deny = (reason) => json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `seaworthy: ${reason}` } })

/** @param {string} reason @returns {HookResult} */
export const ask = (reason) => json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `seaworthy: ${reason}` } })

/** @param {string} reason @returns {HookResult} */
export const block = (reason) => json({ decision: 'block', reason: `seaworthy: ${reason}` })

/**
 * @param {string} event
 * @param {string} text
 * @returns {HookResult}
 */
export const context = (event, text) => json({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })

/**
 * Loads everything a hook needs. `active` is true only when a session exists for this worktree
 * and belongs to the Claude Code session that fired the hook.
 * @param {HookInput} input
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<HookContext | null>} null when not inside a git repository
 */
export async function load(input, env) {
  const cwd = input.cwd || process.cwd()
  if (!(await isGitRepo(cwd))) return null
  const root = await topLevel(cwd)
  /** @type {import('../state.js').State | null} */
  let state = null
  /** @type {string | null} */
  let tampered = null
  try {
    state = await loadState(root, env)
  } catch (err) {
    if (err instanceof TamperError) tampered = err.message
    else throw err
  }
  /** @type {import('../config.js').Config | null} */
  let cfg = null
  try {
    cfg = await loadConfig(root)
  } catch {
    cfg = null
  }
  const active = Boolean(state && input.session_id && state.session_id === input.session_id && !['stopped', 'done'].includes(state.phase))
  const gating = Boolean(state && !['stopped', 'done'].includes(state.phase))
  return { input, env, root, state, tampered, cfg, active, gating }
}

/** Paths a session protects besides the repo-relative ones. @param {Record<string, string | undefined>} env */
export function extraProtected(env) {
  const out = [keyDir(env)]
  if (env.CLAUDE_PLUGIN_ROOT) out.push(env.CLAUDE_PLUGIN_ROOT)
  return out
}

/** @param {string} p */
function realOrSelf(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Resolves a path the way the OS will when writing it: through symlinks in any existing parent.
 * @param {string} cwd
 * @param {string} p
 */
export function resolveForWrite(cwd, p) {
  const expanded = p.startsWith('~/') ? join(process.env.HOME ?? '', p.slice(2)) : p
  let cur = resolve(cwd, expanded)
  /** @type {string[]} */
  const rest = []
  while (!existsSync(cur)) {
    const parent = dirname(cur)
    if (parent === cur) break
    rest.unshift(basename(cur))
    cur = parent
  }
  return join(realOrSelf(cur), ...rest)
}

/**
 * Everything the session protects, for the Bash analyzer and the Edit/Write check.
 * @param {HookContext} ctx
 */
export async function protection(ctx) {
  const hooksR = await git(ctx.root, ['rev-parse', '--git-path', 'hooks'])
  const commonR = await git(ctx.root, ['rev-parse', '--git-common-dir'])
  const hooksDir = hooksR.code === 0 ? realOrSelf(resolve(ctx.root, hooksR.stdout.trim())) : null
  const common = commonR.code === 0 ? realOrSelf(resolve(ctx.root, commonR.stdout.trim())) : join(ctx.root, '.git')
  const hidden = [keyDir(ctx.env), join(common, 'seaworthy-core')]
  if (ctx.env.CLAUDE_PLUGIN_ROOT) hidden.push(ctx.env.CLAUDE_PLUGIN_ROOT, realOrSelf(ctx.env.CLAUDE_PLUGIN_ROOT))
  const protectedPaths = [...extraProtected(ctx.env), ...hidden, common]
  if (hooksDir) protectedPaths.push(hooksDir)
  const cwd = ctx.input.cwd || ctx.root
  return { protectedPaths, hiddenPaths: hidden, resolve: (/** @type {string} */ p) => resolveForWrite(cwd, p) }
}

/** The developer's git aliases, so `git ci` is read as `git commit`. @param {string} root */
export async function gitAliases(root) {
  const r = await git(root, ['config', '--get-regexp', '^alias\\.'])
  /** @type {Record<string, string>} */
  const aliases = {}
  if (r.code !== 0) return aliases
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^alias\.(\S+)\s+(.*)$/)
    if (m) aliases[m[1]] = m[2]
  }
  return aliases
}
