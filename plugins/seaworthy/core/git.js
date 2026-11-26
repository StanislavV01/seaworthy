// @ts-check
import { spawn } from 'node:child_process'
import { mkdtemp, rm, copyFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} ExecResult
 */

/**
 * Runs a program without a shell.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string, string | undefined>, input?: string, timeoutMs?: number }} opts
 * @returns {Promise<ExecResult>}
 */
export function exec(cmd, args, opts) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    if (opts.timeoutMs) timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolvePromise({ code: 127, stdout, stderr: stderr + String(err.message) })
    })
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolvePromise({ code: code ?? (signal ? 124 : 1), stdout, stderr })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(opts.input ?? '')
  })
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string | undefined>} [env]
 */
export function git(cwd, args, env) {
  return exec('git', args, { cwd, env: { GIT_TERMINAL_PROMPT: '0', ...env } })
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
async function gitOut(cwd, args) {
  const r = await git(cwd, args)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`)
  return r.stdout.trim()
}

/** @param {string} cwd */
export async function isGitRepo(cwd) {
  return (await git(cwd, ['rev-parse', '--git-dir'])).code === 0
}

/** Absolute path of this worktree's git dir (a linked worktree has its own). @param {string} cwd */
export async function gitDir(cwd) {
  const r = await git(cwd, ['rev-parse', '--absolute-git-dir'])
  const d = r.code === 0 ? r.stdout.trim() : await gitOut(cwd, ['rev-parse', '--git-dir'])
  const abs = isAbsolute(d) ? d : resolve(cwd, d)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

/** Top level of the working tree. @param {string} cwd */
export async function topLevel(cwd) {
  const t = await gitOut(cwd, ['rev-parse', '--show-toplevel'])
  try {
    return realpathSync(t)
  } catch {
    return t
  }
}

/** @param {string} cwd @returns {Promise<string | null>} */
export async function headSha(cwd) {
  const r = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])
  return r.code === 0 ? r.stdout.trim() : null
}

/** @param {string} cwd @returns {Promise<string | null>} */
export async function currentBranch(cwd) {
  const r = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])
  return r.code === 0 ? r.stdout.trim() : null
}

/** `origin`'s default branch, else `main`. @param {string} cwd */
export async function defaultBranch(cwd) {
  const r = await git(cwd, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, '')
  for (const b of ['main', 'master']) if ((await git(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${b}`])).code === 0) return b
  return 'main'
}

/**
 * Content fingerprint of the whole working tree (tracked + untracked, minus ignored),
 * computed with a throwaway index so the real index is never touched.
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export async function treeFingerprint(cwd) {
  const dir = await mkdtemp(join(tmpdir(), 'seaworthy-idx-'))
  const index = join(dir, 'index')
  try {
    const real = join(await gitDir(cwd), 'index')
    if (existsSync(real)) await copyFile(real, index)
    const env = { GIT_INDEX_FILE: index }
    const top = await topLevel(cwd)
    const add = await git(top, ['add', '-A', '--', '.'], env)
    if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`)
    const w = await git(top, ['write-tree'], env)
    if (w.code !== 0) throw new Error(`git write-tree failed: ${w.stderr.trim()}`)
    return w.stdout.trim()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Paths that differ between two tree ids (or a tree and the working tree fingerprint).
 * @param {string} cwd
 * @param {string} fromTree
 * @param {string} toTree
 * @returns {Promise<{ status: string, path: string, oldPath?: string }[]>}
 */
export async function diffTrees(cwd, fromTree, toTree) {
  const out = await gitOut(cwd, ['diff-tree', '-r', '-M', '--name-status', fromTree, toTree])
  if (!out) return []
  return out.split('\n').map((line) => {
    const parts = line.split('\t')
    const status = parts[0][0]
    return status === 'R' ? { status, oldPath: parts[1], path: parts[2] } : { status, path: parts[1] }
  })
}

/**
 * File content at a tree (null when absent).
 * @param {string} cwd
 * @param {string} tree
 * @param {string} path
 */
export async function showFile(cwd, tree, path) {
  const r = await git(cwd, ['show', `${tree}:${path}`])
  return r.code === 0 ? r.stdout : null
}

/** @param {string} cwd @param {number} n */
export async function recentCommitMessages(cwd, n) {
  const r = await git(cwd, ['log', `-${n}`, '--format=%B%x00'])
  if (r.code !== 0) return []
  return r.stdout.split('\0').map((s) => s.trim()).filter(Boolean)
}
