// @ts-check
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isGreen } from './checks.js'
import { configHash } from './config.js'
import { allowedTrailerKeys, checkMessage, parseCommitArgs } from './commit-rules.js'
import { currentBranch, defaultBranch, git, treeFingerprint } from './git.js'
import { openEvents, scanGuard } from './guard.js'

/**
 * @typedef {{ ok: boolean, reasons: string[], tree: string }} GateResult
 */

/**
 * Everything that must hold before `git commit` during a session.
 * Shared by the Claude Code PreToolUse hook and the git pre-commit / commit-msg backstop.
 * @param {{ root: string, state: import('./state.js').State, cfg: import('./config.js').Config, argv?: string[], message?: string | null, cwd?: string }} p
 * @returns {Promise<GateResult>}
 */
export async function commitGate(p) {
  const { root, state, cfg } = p
  /** @type {string[]} */
  const reasons = []
  const tree = await treeFingerprint(root)

  if (p.argv) {
    const args = parseCommitArgs(p.argv)
    reasons.push(...args.reasons)
    let msg = args.messages.join('\n\n')
    if (args.messageFile) {
      const f = isAbsolute(args.messageFile) ? args.messageFile : join(p.cwd ?? root, args.messageFile)
      if (args.messageFile === '-') reasons.push('-F - (stdin) is not allowed; write the message to a file')
      else if (existsSync(f)) msg += (msg ? '\n\n' : '') + (await readFile(f, 'utf8'))
      else reasons.push(`message file ${args.messageFile} not found`)
    }
    reasons.push(...checkMessage(msg, args.trailers, await allowedTrailerKeys(root, cfg)))
    if (args.pathspec) reasons.push('commit staged changes only (`git add <paths>` then `git commit -m …`), not `git commit -- <paths>`')
  } else if (p.message !== undefined && p.message !== null) {
    reasons.push(...checkMessage(p.message, [], await allowedTrailerKeys(root, cfg)))
  }

  if (state.config_hash && configHash(cfg) !== state.config_hash) reasons.push('.seaworthy.json changed during the session; the developer must restart it with /seaworthy:ship')
  if (!isGreen(state, 'commit', tree, cfg)) {
    const last = state.checks.commit ?? state.checks.push
    reasons.push(
      last && last.tree === tree && !last.ok
        ? `commit checks are red (${last.failed.join(', ')}); fix them and run \`seaworthy check --tier commit\``
        : 'commit checks have not passed for the current code; run `seaworthy check --tier commit`',
    )
  }
  if (!state.review || state.review.tree !== tree || state.review.verdict !== 'approve') {
    reasons.push(
      state.review && state.review.tree === tree
        ? `the reviewer requested changes (${state.review.findings.filter((f) => f.status === 'open').length} open findings); address them and review again`
        : 'no approved review for the current code; dispatch the seaworthy:reviewer agent with the diff',
    )
  }
  const open = openEvents(await scanGuard(root, state.start_tree), state.approvals)
  for (const e of open)
    reasons.push(`guard ${e.id}: ${e.type} in ${e.path} (${e.detail}) — revert it, or ask the developer with \`seaworthy request-approval ${e.id}\``)
  return { ok: reasons.length === 0, reasons, tree }
}

const PUSH_FLAGS = new Set(['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose', '--progress', '--no-progress', '--dry-run', '-n', '--porcelain', '--atomic', '--verify', '--follow-tags', '--signed', '--no-signed', '--ipv4', '--ipv6', '-4', '-6'])
const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--recurse-submodules', '--signed'])

/** `heads/main`, `refs/heads/main`, `main` → `main`. @param {string} r */
const branchName = (r) => r.replace(/^refs\/heads\//, '').replace(/^heads\//, '')

/**
 * Parses `git push` arguments into flags, sources and destinations. Unknown or abbreviated
 * options are reported, because git accepts unique prefixes (`--no-ver` = `--no-verify`).
 * @param {string[]} argv
 * @param {string | null} current
 */
export function parsePush(argv, current) {
  /** @type {string[]} */
  const unknown = []
  let force = false
  let lease = false
  let deletes = false
  let all = false
  let noVerify = false
  /** @type {string[]} */
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('-') || a === '-') {
      pos.push(a)
      continue
    }
    const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a
    if (name === '--force' || name === '-f') force = true
    else if (name === '--force-with-lease' || name === '--force-if-includes') {
      force = true
      lease = true
    } else if (name === '--delete' || name === '-d' || name === '--prune') deletes = true
    else if (name === '--all' || name === '--mirror' || name === '--tags' || name === '--branches') all = true
    else if (name === '--no-verify') noVerify = true
    else if (PUSH_VALUE_FLAGS.has(name)) {
      if (!a.includes('=') && name !== '--signed') i++
    } else if (/^-[a-zA-Z]{2,}$/.test(a)) {
      for (const ch of a.slice(1)) {
        if (ch === 'f') force = true
        else if (ch === 'd') deletes = true
        else if (!'uqvn46'.includes(ch)) unknown.push(`-${ch}`)
      }
    } else if (!PUSH_FLAGS.has(name)) unknown.push(a)
  }
  const refspecs = pos.slice(1)
  if (refspecs.some((r) => r.startsWith('+'))) force = true
  if (refspecs.some((r) => r.startsWith(':'))) deletes = true
  const pairs = refspecs.length
    ? refspecs.map((r) => {
        const s = r.replace(/^\+/, '')
        const [src, dst] = s.includes(':') ? s.split(':') : [s, s]
        const d = branchName(dst)
        return { src: src || 'HEAD', dst: d === 'HEAD' ? current : d }
      })
    : [{ src: 'HEAD', dst: current }]
  return { force, lease, deletes, all, noVerify, unknown, pairs, targets: pairs.map((p) => p.dst) }
}

/**
 * Everything that must hold before `git push` during a session.
 * @param {{ root: string, state: import('./state.js').State, cfg: import('./config.js').Config, argv: string[] }} p
 * @returns {Promise<GateResult>}
 */
export async function pushGate(p) {
  const { root, state, cfg } = p
  /** @type {string[]} */
  const reasons = []
  const tree = await treeFingerprint(root)
  const current = await currentBranch(root)
  const def = await defaultBranch(root)
  const push = parsePush(p.argv, current)
  if (push.noVerify) reasons.push('--no-verify skips the git hooks')
  if (push.unknown.length) reasons.push(`unrecognised push option(s) ${push.unknown.join(', ')}: use full option names`)
  if (push.force && !(push.lease && state.force_push_allowed)) reasons.push('force push is not allowed (the developer can allow --force-with-lease once with `seaworthy allow-force-push`)')
  if (push.deletes) reasons.push('deleting remote branches is not allowed during a session')
  if (push.all) reasons.push('push one branch at a time (no --all, --mirror, --branches or --tags)')
  if (push.targets.some((t) => t !== null && branchName(t).toLowerCase() === def.toLowerCase())) reasons.push(`pushing to the default branch ${def} is not allowed; push a feature branch and open a PR`)
  if (push.targets.some((t) => t === null)) reasons.push('detached HEAD: create a branch first')
  const headSha = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).stdout.trim()
  for (const pair of push.pairs) {
    const src = await git(root, ['rev-parse', '--verify', '-q', `${pair.src}^{commit}`])
    if (src.code !== 0 || src.stdout.trim() !== headSha) reasons.push(`only the checked HEAD can be pushed (\`${pair.src}\` is not HEAD)`)
  }
  const head = await git(root, ['rev-parse', '--verify', '-q', 'HEAD^{tree}'])
  if (head.code !== 0 || head.stdout.trim() !== tree) reasons.push('there are uncommitted changes; the pushed code must be exactly the checked code — commit or discard them')
  if (!isGreen(state, 'push', tree, cfg)) reasons.push('push checks (including build) have not passed for this code; run `seaworthy check --tier push`')
  const open = openEvents(await scanGuard(root, state.start_tree), state.approvals)
  if (open.length) reasons.push(`${open.length} unapproved guard event(s): ${open.map((e) => e.id).join(', ')}`)
  return { ok: reasons.length === 0, reasons, tree }
}
