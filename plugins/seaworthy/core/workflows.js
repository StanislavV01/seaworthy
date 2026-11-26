// @ts-check
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * @typedef {{ branches: string[] | null, ignore: string[] }} PushTrigger
 * @typedef {{ file: string, push: PushTrigger | null, pullRequest: boolean, runSteps: string[] }} Workflow
 */

/** @param {string} line */
const indentOf = (line) => line.length - line.trimStart().length

/** @param {string} s */
const unquote = (s) => s.trim().replace(/^['"]|['"]$/g, '')

/** @param {string} s */
function inlineList(s) {
  const m = s.trim().match(/^\[(.*)\]$/)
  if (!m) return null
  return m[1]
    .split(',')
    .map(unquote)
    .filter(Boolean)
}

/**
 * Line-based reading of the parts of a GitHub Actions workflow that seaworthy needs.
 * Not a YAML parser: it understands the common shapes of `on:` and `run:`.
 * @param {string} text
 * @param {string} file
 * @returns {Workflow}
 */
export function parseWorkflow(text, file) {
  const lines = text.split(/\r?\n/)
  /** @type {Workflow} */
  const wf = { file, push: null, pullRequest: false, runSteps: [] }

  const onIdx = lines.findIndex((l) => /^["']?on["']?\s*:/.test(l))
  if (onIdx >= 0) {
    const rest = lines[onIdx].replace(/^["']?on["']?\s*:/, '').trim()
    const list = inlineList(rest)
    const events = list ?? (rest ? [unquote(rest)] : null)
    if (events) {
      if (events.includes('push')) wf.push = { branches: null, ignore: [] }
      if (events.includes('pull_request') || events.includes('pull_request_target')) wf.pullRequest = true
    } else {
      /** @type {string | null} */
      let event = null
      /** @type {'branches' | 'ignore' | null} */
      let listKey = null
      let eventIndent = -1
      for (let i = onIdx + 1; i < lines.length; i++) {
        const line = lines[i]
        if (!line.trim() || line.trim().startsWith('#')) continue
        const ind = indentOf(line)
        if (ind === 0) break
        const t = line.trim()
        if (eventIndent < 0) eventIndent = ind
        if (ind === eventIndent) {
          event = t.replace(/:.*$/, '').trim()
          listKey = null
          if (event === 'push') wf.push = { branches: null, ignore: [] }
          if (event === 'pull_request' || event === 'pull_request_target') wf.pullRequest = true
          continue
        }
        if (event !== 'push' || !wf.push) continue
        const kv = t.match(/^(branches|branches-ignore)\s*:\s*(.*)$/)
        if (kv) {
          listKey = kv[1] === 'branches' ? 'branches' : 'ignore'
          const items = inlineList(kv[2]) ?? []
          if (listKey === 'branches') wf.push.branches = [...(wf.push.branches ?? []), ...items]
          else wf.push.ignore.push(...items)
          continue
        }
        const item = t.match(/^-\s*(.+)$/)
        if (item && listKey) {
          if (listKey === 'branches') wf.push.branches = [...(wf.push.branches ?? []), unquote(item[1])]
          else wf.push.ignore.push(unquote(item[1]))
          continue
        }
        if (!t.startsWith('-')) listKey = null
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:-\s*)?run\s*:\s*(.*)$/)
    if (!m) continue
    const value = m[2].trim()
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const base = indentOf(lines[i])
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() && indentOf(lines[j]) <= base) break
        if (lines[j].trim()) wf.runSteps.push(lines[j].trim())
      }
    } else if (value) {
      wf.runSteps.push(unquote(value))
    }
  }
  return wf
}

/**
 * @param {string} root
 * @returns {Promise<Workflow[]>}
 */
export async function readWorkflows(root) {
  const dir = join(root, '.github', 'workflows')
  if (!existsSync(dir)) return []
  const files = (await readdir(dir)).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort()
  return Promise.all(files.map(async (f) => parseWorkflow(await readFile(join(dir, f), 'utf8'), f)))
}

/**
 * GitHub branch filter glob: `*` matches within a segment, `**` across segments.
 * @param {string} pattern
 * @param {string} branch
 */
export function branchMatches(pattern, branch) {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${re}$`).test(branch)
}

/**
 * Would pushing `branch` start at least one workflow run?
 * @param {Workflow[]} workflows
 * @param {string} branch
 */
export function ciRunsOnPush(workflows, branch) {
  return workflows.some((w) => {
    if (!w.push) return false
    if (w.push.ignore.some((p) => branchMatches(p, branch))) return false
    return w.push.branches === null || w.push.branches.some((p) => branchMatches(p, branch))
  })
}

/** @param {Workflow[]} workflows */
export const hasPullRequestCi = (workflows) => workflows.some((w) => w.pullRequest)

const SETUP = /^(npm (ci|install|i)\b|pnpm (install|i)\b|yarn( install)?$|bun install|npx playwright install|corepack|git |echo |cd )/
const CHECKISH = /\b(lint|test|typecheck|type-check|tsc|build|vitest|jest|eslint|biome|oxlint)\b/

/**
 * @param {string} step
 * @param {{ id: string, script: string }} check
 */
function stepRunsCheck(step, check) {
  const s = check.script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`\\b(npm|pnpm|yarn|bun)\\s+(run\\s+)?${s}\\b`).test(step)) return true
  if (check.id === 'test' && /\b(npm|pnpm|yarn|bun)\s+t(est)?\b/.test(step)) return true
  return false
}

/**
 * Warnings about drift between local checks and CI steps.
 * @param {{ checks: { id: string, script: string }[] }} config
 * @param {Workflow[]} workflows
 * @returns {string[]}
 */
export function crossCheck(config, workflows) {
  if (workflows.length === 0) return ['no GitHub Actions workflows found: CI will not be watched']
  const steps = workflows.flatMap((w) => w.runSteps)
  /** @type {string[]} */
  const warnings = []
  for (const step of steps) {
    if (SETUP.test(step) || !CHECKISH.test(step)) continue
    if (!config.checks.some((c) => stepRunsCheck(step, c))) warnings.push(`CI runs \`${step}\` but no local check matches it`)
  }
  for (const c of config.checks) {
    if (!steps.some((s) => stepRunsCheck(s, c))) warnings.push(`local check ${c.id} (\`${c.script}\`) does not run in CI`)
  }
  return warnings
}
