// @ts-check
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** @typedef {'npm' | 'pnpm' | 'yarn' | 'bun' | 'none'} PackageManager */
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
const EXEC = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx', none: '' }

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
  if (!existsSync(pkgPath)) return detectGeneric(root)
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

/** @param {string} p */
const q = (p) => (/^[\w./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`)

/**
 * Checks for one non-JS component directory (C/C++, Python, Go), or null.
 * @param {string} dir absolute
 * @returns {Promise<Partial<Record<CheckId, string>> | null>}
 */
async function componentChecks(dir) {
  /** @type {Partial<Record<CheckId, string>>} */
  const c = {}
  // Go
  if (existsSync(join(dir, 'go.mod'))) {
    c.typecheck = 'go vet ./...'
    c.test = 'go test ./...'
    c.build = 'go build ./...'
    return c
  }
  // C / C++: a build script that produces a test binary, else CMake + CTest, else make test
  if (existsSync(join(dir, 'build.sh'))) {
    const sh = await readFile(join(dir, 'build.sh'), 'utf8')
    const outs = [...sh.matchAll(/-o\s+(\S*test\S*)/g)].map((m) => m[1].replace(/^["']|["']$/g, ''))
    if (outs.length) c.test = `./build.sh && ${outs.map((o) => (o.startsWith('/') || o.startsWith('.') ? o : `./${o}`)).join(' && ')}`
    else c.build = './build.sh'
  } else if (existsSync(join(dir, 'CMakeLists.txt'))) {
    const cm = await readFile(join(dir, 'CMakeLists.txt'), 'utf8')
    c.build = 'cmake -S . -B build-seaworthy && cmake --build build-seaworthy'
    if (/enable_testing|add_test/.test(cm)) c.test = `${c.build} && ctest --test-dir build-seaworthy --output-on-failure`
  } else if (existsSync(join(dir, 'Makefile'))) {
    const mk = await readFile(join(dir, 'Makefile'), 'utf8')
    if (/^test\s*:/m.test(mk)) c.test = 'make test'
    if (/^lint\s*:/m.test(mk)) c.lint = 'make lint'
    if (/^all\s*:/m.test(mk) || /^build\s*:/m.test(mk)) c.build = /^build\s*:/m.test(mk) ? 'make build' : 'make'
  }
  if (Object.keys(c).length) return c
  // Python
  const testsDir = ['tests', 'test'].find((t) => existsSync(join(dir, t)))
  const hasPy = existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'setup.py')) || existsSync(join(dir, 'pytest.ini'))
  if (testsDir || hasPy) {
    const files = testsDir ? await readdir(join(dir, testsDir)).catch(() => []) : []
    const pyTests = files.filter((f) => /^test_.*\.py$|_test\.py$/.test(f))
    if (!pyTests.length && !hasPy) return null
    let usesPytest = existsSync(join(dir, 'pytest.ini')) || existsSync(join(dir, 'conftest.py'))
    for (const f of pyTests.slice(0, 20)) if (/^\s*import pytest|^\s*from pytest/m.test(await readFile(join(dir, testsDir ?? '', f), 'utf8'))) usesPytest = true
    if (existsSync(join(dir, 'pyproject.toml')) && /\[tool\.pytest/.test(await readFile(join(dir, 'pyproject.toml'), 'utf8'))) usesPytest = true
    c.test = usesPytest ? 'python3 -m pytest -q' : `python3 -m unittest discover -s ${testsDir ?? '.'}`
    if (existsSync(join(dir, 'pyproject.toml')) && /\[tool\.ruff/.test(await readFile(join(dir, 'pyproject.toml'), 'utf8'))) c.lint = 'ruff check .'
    if (existsSync(join(dir, 'pyproject.toml')) && /\[tool\.mypy/.test(await readFile(join(dir, 'pyproject.toml'), 'utf8'))) c.typecheck = 'mypy .'
    return c
  }
  return null
}

/**
 * Non-JS projects: the root and its first-level component directories (C/C++ via build.sh,
 * CMake or make; Python via pytest or unittest; Go). Commands of the same kind are chained.
 * @param {string} root
 * @returns {Promise<ProjectConfig>}
 */
export async function detectGeneric(root) {
  const skip = /^(\.|node_modules$|build|dist$|out$|target$|vendor$|venv$|__pycache__$)/
  const dirs = ['.']
  for (const e of await readdir(root, { withFileTypes: true })) if (e.isDirectory() && !skip.test(e.name)) dirs.push(e.name)
  /** @type {Record<CheckId, string[]>} */
  const parts = { lint: [], typecheck: [], test: [], build: [] }
  for (const d of dirs) {
    const c = await componentChecks(join(root, d))
    if (!c) continue
    for (const id of /** @type {CheckId[]} */ (['lint', 'typecheck', 'test', 'build'])) {
      const cmd = c[id]
      if (cmd) parts[id].push(d === '.' ? cmd : `(cd ${q(d)} && ${cmd})`)
    }
    if (d === '.') break
  }
  /** @type {Check[]} */
  const checks = []
  for (const id of /** @type {CheckId[]} */ (['lint', 'typecheck', 'test', 'build'])) if (parts[id].length) checks.push({ id, cmd: parts[id].join(' && '), script: id })
  if (!checks.length) throw new Error(`no checks found in ${root}: no package.json, build.sh, CMakeLists.txt, Makefile, Python tests or go.mod (write .seaworthy.json by hand)`)
  return { packageManager: 'none', checks, tiers: tiersFor(checks) }
}
