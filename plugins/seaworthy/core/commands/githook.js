// @ts-check
import { readFile } from 'node:fs/promises'
import { loadConfig } from '../config.js'
import { allowedTrailerKeys, checkMessage } from '../commit-rules.js'
import { commitGate, pushGate } from '../gates.js'
import { git, topLevel } from '../git.js'
import { loadState, TamperError } from '../state.js'

const ZERO = /^0+$/

/** @param {NodeJS.ReadableStream} stream */
async function readAll(stream) {
  let s = ''
  for await (const c of stream) s += c
  return s
}

/**
 * `seaworthy githook <pre-commit|commit-msg|pre-push> [args]`: the git-level backstop.
 * Outside a session it passes. During a session it re-checks the same gates as the Claude Code
 * hooks, so a commit or push that slipped past them is still refused by git itself.
 * @type {import('../cli.js').Command}
 */
export async function run(args, io) {
  const [name, ...rest] = args
  const root = await topLevel(io.cwd)
  /** @type {import('../state.js').State | null} */
  let state
  try {
    state = await loadState(root, io.env)
  } catch (err) {
    if (err instanceof TamperError) {
      io.stderr.write(`seaworthy: session state was tampered with (${err.message}). Run \`seaworthy stop\` after checking the repo.\n`)
      return 1
    }
    throw err
  }
  if (!state || state.phase === 'stopped' || state.phase === 'done') return 0
  const cfg = await loadConfig(root)
  if (!cfg) {
    io.stderr.write('seaworthy: .seaworthy.json is missing during an active session\n')
    return 1
  }
  /** @param {string[]} reasons */
  const refuse = (reasons) => {
    io.stderr.write(`seaworthy refused this ${name.replace('pre-', '').replace('-msg', '')} (session active; \`seaworthy stop\` ends it):\n- ${reasons.join('\n- ')}\n`)
    return 1
  }

  if (name === 'pre-commit') {
    const r = await commitGate({ root, state, cfg })
    return r.ok ? 0 : refuse(r.reasons)
  }
  if (name === 'commit-msg') {
    const msg = (await readFile(rest[0], 'utf8')).split('\n').filter((l) => !l.startsWith('#')).join('\n')
    const reasons = checkMessage(msg, [], await allowedTrailerKeys(root, cfg))
    return reasons.length ? refuse(reasons) : 0
  }
  if (name === 'pre-push') {
    const remote = rest[0] ?? 'origin'
    const lines = (await readAll(io.stdin)).split('\n').filter((l) => l.trim())
    /** @type {string[]} */
    const argv = [remote]
    /** @type {string[]} */
    const reasons = []
    for (const line of lines) {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/)
      if (ZERO.test(localSha)) {
        reasons.push(`deleting ${remoteRef} is not allowed during a session`)
        continue
      }
      const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim()
      if (localSha !== head) reasons.push(`only the checked HEAD can be pushed (${localRef} is not HEAD)`)
      const branch = remoteRef.replace(/^refs\/heads\//, '')
      if (!ZERO.test(remoteSha)) {
        const anc = await git(root, ['merge-base', '--is-ancestor', remoteSha, localSha])
        if (anc.code === 1 && !state.force_push_allowed) reasons.push(`push to ${branch} is not a fast-forward (force push)`)
      }
      argv.push(`${localRef}:${branch}`)
    }
    const r = await pushGate({ root, state, cfg, argv })
    reasons.push(...r.reasons)
    return reasons.length ? refuse([...new Set(reasons)]) : 0
  }
  io.stderr.write(`seaworthy githook: unknown hook ${name}\n`)
  return 2
}
