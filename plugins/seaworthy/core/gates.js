// @ts-check
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isGreen } from './checks.js'
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
  } else if (p.message !== undefined && p.message !== null) {
    reasons.push(...checkMessage(p.message, [], await allowedTrailerKeys(root, cfg)))
  }

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

/**
 * Parses `git push` arguments into flags and the destination branch.
 * @param {string[]} argv
 * @param {string | null} current
 */
export function parsePush(argv, current) {
  const flags = argv.filter((a) => a.startsWith('-'))
  const pos = argv.filter((a) => !a.startsWith('-'))
  const refspecs = pos.slice(1)
  const force = flags.some((a) => a === '--force' || a === '-f' || /^-[a-zA-Z]*f/.test(a) || a === '--mirror') || refspecs.some((r) => r.startsWith('+'))
  const lease = flags.some((a) => a.startsWith('--force-with-lease') || a.startsWith('--force-if-includes'))
  const deletes = flags.some((a) => a === '--delete' || a === '-d' || a === '--prune') || refspecs.some((r) => r.startsWith(':'))
  const targets = refspecs.length
    ? refspecs.map((r) => {
        const s = r.replace(/^\+/, '')
        const dst = s.includes(':') ? s.split(':')[1] : s
        return dst.replace(/^refs\/heads\//, '') === 'HEAD' ? current : dst.replace(/^refs\/heads\//, '')
      })
    : [current]
  return { force, lease, deletes, targets, all: flags.includes('--all') || flags.includes('--mirror') || flags.includes('--tags') }
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
  if (push.force && !(push.lease && state.force_push_allowed)) reasons.push('force push is not allowed (the developer can allow --force-with-lease once with `seaworthy allow-force-push`)')
  if (push.deletes) reasons.push('deleting remote branches is not allowed during a session')
  if (push.all) reasons.push('push one branch at a time (no --all, --mirror or --tags)')
  if (push.targets.some((t) => t === def)) reasons.push(`pushing to the default branch ${def} is not allowed; push a feature branch and open a PR`)
  if (push.targets.some((t) => t === null)) reasons.push('detached HEAD: create a branch first')
  const head = await git(root, ['rev-parse', '--verify', '-q', 'HEAD^{tree}'])
  if (head.code !== 0 || head.stdout.trim() !== tree) reasons.push('there are uncommitted changes; the pushed code must be exactly the checked code — commit or discard them')
  if (!isGreen(state, 'push', tree, cfg)) reasons.push('push checks (including build) have not passed for this code; run `seaworthy check --tier push`')
  const open = openEvents(await scanGuard(root, state.start_tree), state.approvals)
  if (open.length) reasons.push(`${open.length} unapproved guard event(s): ${open.map((e) => e.id).join(', ')}`)
  return { ok: reasons.length === 0, reasons, tree }
}
