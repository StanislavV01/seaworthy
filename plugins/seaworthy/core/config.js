// @ts-check
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CONFIG_FILE = '.seaworthy.json'

/** @typedef {'careful' | 'normal' | 'auto'} Autonomy */
/**
 * @typedef {{
 *   fixAttemptsPerCheck: number, sameSignature: number, reviewRounds: number, ciCycles: number,
 *   flakyRerunsPerSha: number, stopBlocks: number, checkTimeoutSec: number, ciWatchSec: number,
 *   ciTotalWaitMin: number, runDiscoverySec: number, excerptChars: number
 * }} Caps
 */
/**
 * @typedef {{
 *   version: 1,
 *   packageManager: import('./detect.js').PackageManager,
 *   checks: import('./detect.js').Check[],
 *   tiers: import('./detect.js').Tiers,
 *   caps: Caps,
 *   autonomy: Autonomy,
 *   allowedTrailers: string[]
 * }} Config
 */

/** @type {Caps} */
export const DEFAULT_CAPS = Object.freeze({
  fixAttemptsPerCheck: 3,
  sameSignature: 2,
  reviewRounds: 2,
  ciCycles: 3,
  flakyRerunsPerSha: 1,
  stopBlocks: 5,
  checkTimeoutSec: 600,
  ciWatchSec: 540,
  ciTotalWaitMin: 30,
  runDiscoverySec: 180,
  excerptChars: 8000,
})

/**
 * @param {import('./detect.js').ProjectConfig} project
 * @returns {Config}
 */
export function configFromProject(project) {
  return {
    version: 1,
    packageManager: project.packageManager,
    checks: project.checks,
    tiers: project.tiers,
    caps: { ...DEFAULT_CAPS },
    autonomy: 'normal',
    allowedTrailers: [],
  }
}

/**
 * JSON with object keys sorted at every level, so equal configs hash equally.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (value)
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** @param {unknown} cfg */
export function configHash(cfg) {
  return createHash('sha256').update(canonicalJson(cfg)).digest('hex')
}

const CHECK_IDS = ['lint', 'typecheck', 'test', 'build']

/**
 * Throws an Error that names the first invalid field.
 * @param {any} c
 * @returns {Config}
 */
export function validateConfig(c) {
  /** @param {string} field @param {string} why */
  const bad = (field, why) => {
    throw new Error(`invalid ${CONFIG_FILE}: ${field} ${why}`)
  }
  if (!c || typeof c !== 'object') bad('(root)', 'must be an object')
  if (c.version !== 1) bad('version', 'must be 1')
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(c.packageManager)) bad('packageManager', 'must be npm, pnpm, yarn or bun')
  if (!Array.isArray(c.checks)) bad('checks', 'must be an array')
  c.checks.forEach((/** @type {any} */ ch, /** @type {number} */ i) => {
    if (!CHECK_IDS.includes(ch?.id)) bad(`checks[${i}].id`, `must be one of ${CHECK_IDS.join(', ')}`)
    if (typeof ch.cmd !== 'string' || !ch.cmd.trim()) bad(`checks[${i}].cmd`, 'must be a non-empty string')
  })
  const ids = new Set(c.checks.map((/** @type {any} */ ch) => ch.id))
  for (const tier of ['fast', 'commit', 'push']) {
    if (!Array.isArray(c.tiers?.[tier])) bad(`tiers.${tier}`, 'must be an array')
    for (const id of c.tiers[tier]) if (!ids.has(id)) bad(`tiers.${tier}`, `references unknown check "${id}"`)
  }
  for (const [k, v] of Object.entries(DEFAULT_CAPS)) {
    const got = c.caps?.[k]
    if (got === undefined) continue
    if (typeof got !== 'number' || !Number.isFinite(got) || got < 0) bad(`caps.${k}`, `must be a non-negative number (default ${v})`)
  }
  if (!['careful', 'normal', 'auto'].includes(c.autonomy)) bad('autonomy', 'must be careful, normal or auto')
  if (!Array.isArray(c.allowedTrailers) || c.allowedTrailers.some((/** @type {any} */ t) => typeof t !== 'string'))
    bad('allowedTrailers', 'must be an array of strings')
  return { ...c, caps: { ...DEFAULT_CAPS, ...c.caps } }
}

/**
 * @param {string} root
 * @returns {Promise<Config | null>}
 */
export async function loadConfig(root) {
  const p = join(root, CONFIG_FILE)
  if (!existsSync(p)) return null
  return validateConfig(JSON.parse(await readFile(p, 'utf8')))
}

/**
 * @param {string} root
 * @param {Config} cfg
 */
export async function saveConfig(root, cfg) {
  await writeFile(join(root, CONFIG_FILE), JSON.stringify(validateConfig(cfg), null, 2) + '\n')
}
