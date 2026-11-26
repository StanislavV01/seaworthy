// @ts-check
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const FIXTURES = join(ROOT, 'test', 'fixtures')
export const CLI = join(ROOT, 'plugins', 'seaworthy', 'core', 'cli.js')

/** @param {string} [prefix] */
export function tmp(prefix = 'sw-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * @param {string} dir
 * @param {Record<string, string>} files
 */
export function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
export function sh(cwd, args) {
  return execFileSync(args[0], args.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * New git repo with an initial commit.
 * @param {Record<string, string>} [files]
 */
export function repo(files = { 'README.md': '# x\n' }) {
  const dir = tmp('sw-repo-')
  sh(dir, ['git', 'init', '-q', '-b', 'main'])
  sh(dir, ['git', 'config', 'user.name', 'Test'])
  sh(dir, ['git', 'config', 'user.email', 'test@example.com'])
  sh(dir, ['git', 'config', 'commit.gpgsign', 'false'])
  writeFiles(dir, files)
  sh(dir, ['git', 'add', '-A'])
  sh(dir, ['git', 'commit', '-q', '-m', 'init'])
  return dir
}

/** @param {string} name */
export function fixtureCopy(name) {
  const dir = tmp('sw-fx-')
  cpSync(join(FIXTURES, name), dir, { recursive: true })
  return dir
}

/**
 * Captures IO for calling commands in-process.
 * @param {string} cwd
 * @param {string} [stdinText]
 * @param {Record<string,string|undefined>} [env]
 */
export function captureIO(cwd, stdinText = '', env = {}) {
  const stdin = new PassThrough()
  stdin.end(stdinText)
  let out = ''
  let err = ''
  return {
    io: {
      stdin,
      stdout: { write: (/** @type {string} */ s) => (out += s) },
      stderr: { write: (/** @type {string} */ s) => (err += s) },
      cwd,
      env: { ...process.env, SEAWORTHY_KEY_DIR: join(cwd, '..', `.swkey-${Date.now()}-${Math.random()}`), CLAUDE_PLUGIN_ROOT: undefined, ...env },
    },
    out: () => out,
    err: () => err,
  }
}
