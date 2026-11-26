// @ts-check
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** @typedef {'npm' | 'pnpm' | 'yarn' | 'bun'} PackageManager */
/** @typedef {'lint' | 'typecheck' | 'test' | 'build'} CheckId */
/** @typedef {{ id: CheckId, cmd: string, script: string, perFile?: string }} Check */
/** @typedef {{ fast: CheckId[], commit: CheckId[], push: CheckId[] }} Tiers */
/** @typedef {{ packageManager: PackageManager, checks: Check[], tiers: Tiers }} ProjectConfig */

/** @type {[string, PackageManager][]} */
const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
]

/** Script names that map to each check, in priority order. */
/** @type {Record<CheckId, string[]>} */
const SCRIPT_NAMES = {
  lint: ['lint'],
  typecheck: ['typecheck', 'type-check', 'types', 'tsc', 'check-types'],
  test: ['test'],
  build: ['build'],
}

const NPM_PLACEHOLDER = /no test specified/

/**
 * @param {unknown} pkg
 * @param {string} root
 * @returns {PackageManager}
 */
export function detectPackageManager(pkg, root) {
  const field = pkg && typeof pkg === 'object' && 'packageManager' in pkg ? String(pkg.packageManager) : ''
  const name = field.split('@')[0]
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') return name
  for (const [file, pm] of LOCKFILES) if (existsSync(join(root, file))) return pm
  return 'npm'
}

/**
 * @param {PackageManager} pm
 * @param {string} script
 */
export function runCommand(pm, script) {
  return `${pm} run ${script}`
}

/** @type {Record<PackageManager, string>} */
const EXEC = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' }

/**
 * A per-file lint command for well-known linters, with `{files}` as the placeholder.
 * @param {PackageManager} pm
 * @param {string} script the script body, e.g. "eslint ."
 * @returns {string | undefined}
 */
export function perFileLint(pm, script) {
  const m = script.trim().match(/^(eslint|oxlint|biome lint|biome check)\b/)
  if (!m) return undefined
  return `${EXEC[pm]} ${m[1]} {files}`
}

/**
 * @param {Check[]} checks
 * @returns {Tiers}
 */
export function tiersFor(checks) {
  const have = new Set(checks.map((c) => c.id))
  /** @param {CheckId[]} ids */
  const pick = (ids) => ids.filter((id) => have.has(id))
  return {
    fast: pick(['lint', 'typecheck']),
    commit: pick(['lint', 'typecheck', 'test']),
    push: pick(['lint', 'typecheck', 'test', 'build']),
  }
}

/**
 * Detects a JS/TS project's package manager, checks and tiers.
 * @param {string} root
 * @returns {Promise<ProjectConfig>}
 */
export async function detectProject(root) {
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) throw new Error(`no package.json in ${root} (only JS/TS projects are supported in v0.1)`)
  /** @type {{ scripts?: Record<string, string>, packageManager?: string }} */
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  const pm = detectPackageManager(pkg, root)
  const scripts = pkg.scripts ?? {}
  /** @type {Check[]} */
  const checks = []
  for (const id of /** @type {CheckId[]} */ (['lint', 'typecheck', 'test', 'build'])) {
    const script = SCRIPT_NAMES[id].find((s) => typeof scripts[s] === 'string' && scripts[s].trim() !== '')
    if (!script) continue
    if (id === 'test' && NPM_PLACEHOLDER.test(scripts[script])) continue
    /** @type {Check} */
    const check = { id, cmd: runCommand(pm, script), script }
    if (id === 'lint') {
      const pf = perFileLint(pm, scripts[script])
      if (pf) check.perFile = pf
    }
    checks.push(check)
  }
  return { packageManager: pm, checks, tiers: tiersFor(checks) }
}
