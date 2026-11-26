// @ts-check
import { recentCommitMessages } from './git.js'

const TRAILER_LINE = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s+\S/

/**
 * Trailer keys (lowercased) in the last paragraph of a commit message.
 * @param {string} msg
 * @returns {string[]}
 */
export function trailerKeys(msg) {
  const paras = msg.replace(/\r/g, '').trim().split(/\n\s*\n/)
  if (paras.length < 2) return []
  const last = paras[paras.length - 1].split('\n').filter((l) => !l.startsWith('#'))
  if (!last.length || !last.every((l) => TRAILER_LINE.test(l) || /^\s+\S/.test(l))) return []
  return last.map((l) => l.match(TRAILER_LINE)?.[1].toLowerCase()).filter((k) => typeof k === 'string')
}

/**
 * Trailer keys the developer already uses (last 20 commits) plus configured ones.
 * @param {string} cwd
 * @param {{ allowedTrailers?: string[] } | null} cfg
 */
export async function allowedTrailerKeys(cwd, cfg) {
  const keys = new Set((cfg?.allowedTrailers ?? []).map((k) => k.toLowerCase()))
  for (const m of await recentCommitMessages(cwd, 20)) for (const k of trailerKeys(m)) keys.add(k)
  return keys
}

/**
 * @typedef {{ reasons: string[], messages: string[], messageFile: string | null, trailers: string[], amend: boolean }} CommitArgs
 */

/**
 * Parses `git commit` arguments and rejects the ones that bypass gates or identity.
 * @param {string[]} argv arguments after `commit`
 * @returns {CommitArgs}
 */
export function parseCommitArgs(argv) {
  /** @type {CommitArgs} */
  const r = { reasons: [], messages: [], messageFile: null, trailers: [], amend: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') break
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    const name = eq > 0 ? a.slice(0, eq) : a
    const val = () => (eq > 0 ? a.slice(eq + 1) : argv[++i] ?? '')
    switch (name) {
      case '--no-verify':
        r.reasons.push('--no-verify skips the git hooks')
        continue
      case '--author':
        val()
        r.reasons.push('--author would commit as someone else')
        continue
      case '--amend':
        r.amend = true
        r.reasons.push('--amend rewrites an existing commit; make a new commit instead')
        continue
      case '--reuse-message':
      case '--reedit-message':
        val()
        r.reasons.push(`${name} copies another commit's message; write the message with -m or -F`)
        continue
      case '--message':
        r.messages.push(val())
        continue
      case '--file':
        r.messageFile = val()
        continue
      case '--trailer':
        r.trailers.push(val().split(/[:=]/)[0].trim().toLowerCase())
        continue
      case '--signoff':
        r.trailers.push('signed-off-by')
        continue
      case '--edit':
        r.reasons.push('--edit opens an editor; pass the message with -m or -F')
        continue
      case '--template':
        val()
        r.reasons.push('--template is not allowed; pass the message with -m or -F')
        continue
      case '--cleanup':
      case '--date':
      case '--gpg-sign':
      case '--fixup':
      case '--squash':
      case '--pathspec-from-file':
        if (eq < 0 && name !== '--gpg-sign') i++
        continue
    }
    if (/^-[a-zA-Z]+$/.test(a)) {
      const letters = a.slice(1)
      for (let k = 0; k < letters.length; k++) {
        const f = letters[k]
        const rest = letters.slice(k + 1)
        if (f === 'm' || f === 'F' || f === 'C' || f === 'c' || f === 't') {
          const v = rest || argv[++i] || ''
          if (f === 'm') r.messages.push(v)
          else if (f === 'F') r.messageFile = v
          else if (f === 't') r.reasons.push('-t (template) is not allowed; pass the message with -m or -F')
          else r.reasons.push(`-${f} copies another commit's message; write the message with -m or -F`)
          break
        }
        if (f === 'n') r.reasons.push('-n (--no-verify) skips the git hooks')
        if (f === 's') r.trailers.push('signed-off-by')
        if (f === 'e') r.reasons.push('-e opens an editor; pass the message with -m or -F')
      }
    }
  }
  if (r.messages.length === 0 && r.messageFile === null && !r.amend) r.reasons.push('no message: pass it with -m or -F so no editor opens')
  return r
}

/**
 * @param {string} msg full message
 * @param {string[]} extraTrailers keys added by flags (--trailer, -s)
 * @param {Set<string>} allowed
 * @returns {string[]} reasons
 */
export function checkMessage(msg, extraTrailers, allowed) {
  const keys = [...trailerKeys(msg), ...extraTrailers]
  const bad = [...new Set(keys.filter((k) => !allowed.has(k)))]
  if (!bad.length) return []
  return [`commit message adds trailer(s) not used in this repo: ${bad.join(', ')} — commits must look like the developer's own; remove them (or add them to allowedTrailers in .seaworthy.json)`]
}
