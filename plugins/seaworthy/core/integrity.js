// @ts-check
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * One per-machine directory for the key and session markers, the same for hooks, the CLI and
 * the Orca worker (so all of them can verify each other's writes). Outside every repository.
 * @param {Record<string, string | undefined>} env
 */
export function keyDir(env) {
  if (env.SEAWORTHY_KEY_DIR) return env.SEAWORTHY_KEY_DIR
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config')
  return join(base, 'seaworthy')
}

/** @param {Record<string, string | undefined>} env */
export const keyPath = (env) => join(keyDir(env), 'key')

/**
 * Reads the HMAC key, creating it (0600) on first use.
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<Buffer>}
 */
export async function getKey(env) {
  const p = keyPath(env)
  if (!existsSync(p)) {
    await mkdir(keyDir(env), { recursive: true, mode: 0o700 })
    await writeFile(p, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }).catch((err) => {
      if (err.code !== 'EEXIST') throw err
    })
    await chmod(p, 0o600).catch(() => {})
  }
  return Buffer.from((await readFile(p, 'utf8')).trim(), 'hex')
}

/**
 * @param {Buffer} key
 * @param {string} text
 */
export function sign(key, text) {
  return createHmac('sha256', key).update(text).digest('hex')
}

/**
 * @param {Buffer} key
 * @param {string} text
 * @param {string} mac
 */
export function verify(key, text, mac) {
  const want = Buffer.from(sign(key, text), 'hex')
  const got = Buffer.from(String(mac), 'hex')
  return want.length === got.length && timingSafeEqual(want, got)
}

/**
 * Where the marker for a worktree's session lives (keyed by its git dir).
 * @param {Record<string, string | undefined>} env
 * @param {string} gitDirPath
 */
export function markerPath(env, gitDirPath) {
  const id = createHash('sha256').update(gitDirPath).digest('hex').slice(0, 32)
  return join(keyDir(env), 'sessions', `${id}.json`)
}
