// @ts-check
import { createHash } from 'node:crypto'
import { diffTrees, showFile, topLevel, treeFingerprint } from './git.js'

/**
 * @typedef {'test_deleted' | 'test_case_removed' | 'skip_added' | 'suppression_added' | 'config_changed'} GuardType
 * @typedef {{ id: string, type: GuardType, path: string, detail: string }} GuardEvent
 */

const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/
const CODE_FILE = /\.([cm]?[jt]sx?|vue|svelte|py|go)$/

/** Patterns whose count going up means a test was switched off. */
const SKIP_PATTERNS = [
  ['.skip', /\b(?:it|test|describe|suite|context)\.skip\b/g],
  ['.only', /\b(?:it|test|describe|suite|context)\.only\b/g],
  ['.todo', /\b(?:it|test)\.todo\b/g],
  ['x-prefixed test', /(?<![\w$.])x(?:it|test|describe)\s*\(/g],
  ['pytest skip', /@pytest\.mark\.(?:skip|xfail)\b/g],
  ['t.Skip', /\bt\.Skip(?:Now|f)?\s*\(/g],
]

/** Patterns whose count going up means a check was silenced. */
const SUPPRESSION_PATTERNS = [
  ['@ts-ignore', /@ts-ignore\b/g],
  ['@ts-expect-error', /@ts-expect-error\b/g],
  ['@ts-nocheck', /@ts-nocheck\b/g],
  ['eslint-disable', /eslint-disable(?:-next-line|-line)?\b/g],
  ['biome-ignore', /biome-ignore\b/g],
  ['oxlint-disable', /oxlint-disable(?:-next-line)?\b/g],
  ['noqa', /#\s*noqa\b/g],
  ['type: ignore', /#\s*type:\s*ignore\b/g],
  ['nolint', /\/\/\s*nolint\b/g],
]

const TEST_CASE = /(?<![\w$.])(?:it|test)(?:\.each\s*\([^)]*\)\s*)?\s*\(|(?<![\w$])def test_\w+\s*\(|func Test\w+\s*\(/g

const CONFIG_FILES = [
  /(^|\/)eslint\.config\.[cm]?[jt]s$/,
  /(^|\/)\.eslintrc(\.\w+)?$/,
  /(^|\/)biome\.jsonc?$/,
  /(^|\/)\.oxlintrc(\.json)?$/,
  /(^|\/)(vitest|jest|playwright|cypress|vite)\.config\.[cm]?[jt]s$/,
  /(^|\/)jest\.config\.json$/,
  /^\.github\/workflows\/[^/]+\.ya?ml$/,
  /^\.husky\//,
  /(^|\/)lefthook\.ya?ml$/,
  /(^|\/)\.pre-commit-config\.yaml$/,
  /(^|\/)\.golangci\.ya?ml$/,
  /(^|\/)(pytest\.ini|setup\.cfg|tox\.ini|ruff\.toml|\.ruff\.toml|mypy\.ini)$/,
  /^\.seaworthy\.json$/,
]
const TSCONFIG = /(^|\/)tsconfig[^/]*\.json$/
const TS_STRICTNESS = /"(strict\w*|noImplicit\w*|noUnused\w*|noUnchecked\w*|exactOptional\w*|noFallthrough\w*|skipLibCheck|checkJs|allowJs|noEmitOnError|useUnknownInCatchVariables)"\s*:\s*[^,\n}]+/g

/** @param {string} text @param {RegExp} re */
const count = (text, re) => (text.match(re) ?? []).length

/** @param {string} text */
const isBinaryish = (text) => text.includes('\u0000') || text.length > 1_000_000

/**
 * @param {GuardType} type
 * @param {string} path
 * @param {string} detail
 * @returns {GuardEvent}
 */
function event(type, path, detail) {
  const id = 'g-' + createHash('sha1').update(`${type}|${path}|${detail}`).digest('hex').slice(0, 8)
  return { id, type, path, detail }
}

/** @param {string | null} json */
function scriptsOf(json) {
  try {
    const s = JSON.parse(json ?? '{}').scripts
    return s && typeof s === 'object' ? s : {}
  } catch {
    return {}
  }
}

/**
 * Compares an old and new version of one file and returns guard events.
 * @param {string} path
 * @param {string | null} before
 * @param {string | null} after
 * @returns {GuardEvent[]}
 */
export function compareFile(path, before, after) {
  /** @type {GuardEvent[]} */
  const out = []
  if (before !== null && isBinaryish(before)) return out
  if (after !== null && isBinaryish(after)) return out
  const isTest = TEST_FILE.test(path)

  if (after === null) {
    if (isTest && before !== null && count(before, TEST_CASE) > 0) out.push(event('test_deleted', path, 'test file deleted'))
    else if (isTest) out.push(event('test_deleted', path, 'file in a test location deleted'))
    return out
  }
  const old = before ?? ''

  if (isTest) {
    const was = count(old, TEST_CASE)
    const now = count(after, TEST_CASE)
    if (now < was) out.push(event('test_case_removed', path, `test cases ${was} → ${now}`))
  }
  if (CODE_FILE.test(path)) {
    for (const [name, re] of SKIP_PATTERNS) {
      const was = count(old, /** @type {RegExp} */ (re))
      const now = count(after, /** @type {RegExp} */ (re))
      if (now > was) out.push(event('skip_added', path, `${name} added (${was} → ${now})`))
    }
    for (const [name, re] of SUPPRESSION_PATTERNS) {
      const was = count(old, /** @type {RegExp} */ (re))
      const now = count(after, /** @type {RegExp} */ (re))
      if (now > was) out.push(event('suppression_added', path, `${name} added (${was} → ${now})`))
    }
  }
  if (CONFIG_FILES.some((re) => re.test(path)) && before !== after) out.push(event('config_changed', path, before === null ? 'config file added' : 'config file changed'))
  if (TSCONFIG.test(path)) {
    const a = new Set(old.match(TS_STRICTNESS) ?? [])
    const b = new Set(after.match(TS_STRICTNESS) ?? [])
    const changed = [...a].filter((x) => !b.has(x)).concat([...b].filter((x) => !a.has(x)))
    if (changed.length) out.push(event('config_changed', path, `compiler strictness changed: ${changed.map((x) => x.replace(/\s+/g, '')).join(', ')}`))
  }
  if (/(^|\/)package\.json$/.test(path)) {
    const a = scriptsOf(before)
    const b = scriptsOf(after)
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    const changed = [...keys].filter((k) => a[k] !== b[k] && /lint|test|type|tsc|check|build|ci|pre/.test(k))
    if (changed.length) out.push(event('config_changed', path, `scripts changed: ${changed.join(', ')}`))
  }
  return out
}

/**
 * Everything changed since the session started that looks like weakening tests or checks.
 * @param {string} cwd
 * @param {string} startTree
 * @returns {Promise<GuardEvent[]>}
 */
export async function scanGuard(cwd, startTree) {
  const root = await topLevel(cwd)
  const now = await treeFingerprint(root)
  if (now === startTree) return []
  const changes = await diffTrees(root, startTree, now)
  /** @type {GuardEvent[]} */
  const events = []
  for (const c of changes) {
    if (c.status === 'R' && c.oldPath) {
      const oldText = await showFile(root, startTree, c.oldPath)
      if (TEST_FILE.test(c.oldPath) && !TEST_FILE.test(c.path)) events.push(event('test_deleted', c.oldPath, `test file moved out of test location to ${c.path}`))
      else events.push(...compareFile(c.path, oldText, await showFile(root, now, c.path)))
      continue
    }
    const before = c.status === 'A' ? null : await showFile(root, startTree, c.path)
    const after = c.status === 'D' ? null : await showFile(root, now, c.path)
    events.push(...compareFile(c.path, before, after))
  }
  return events
}

/**
 * Events not yet approved by the human.
 * @param {GuardEvent[]} events
 * @param {Record<string, unknown>} approvals
 */
export const openEvents = (events, approvals) => events.filter((e) => !approvals[e.id])
