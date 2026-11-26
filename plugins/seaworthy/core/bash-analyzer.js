// @ts-check
import { parseShell } from './shell-parse.js'

/**
 * @typedef {{ verb: string, argv: string[], canonical: boolean, globals: string[] }} GitWrite
 * @typedef {{
 *   gitWrites: GitWrite[],
 *   protectedWrites: string[],
 *   seaworthy: { sub: string, argv: string[] }[],
 *   humanOnly: string[],
 *   ambiguous: string[],
 * }} Analysis
 * @typedef {{
 *   protectedPaths?: string[],
 *   aliases?: Record<string, string>,
 * }} AnalyzeOptions
 */

/** Git subcommands that write history, refs or config. */
const GIT_WRITE_VERBS = new Set([
  'commit', 'commit-tree', 'push', 'update-ref', 'symbolic-ref', 'rebase', 'merge', 'cherry-pick', 'revert',
  'am', 'apply-mailbox', 'filter-branch', 'filter-repo', 'replace', 'notes', 'fast-import', 'pull', 'reset', 'config',
])
/** `git config` keys that change who commits or which hooks run. */
const SENSITIVE_CONFIG = /^(core\.hookspath|user\.|author\.|committer\.|alias\.|include\.|includeif\.|commit\.template|trailer\.|core\.editor|sequence\.editor|gpg\.)/i
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'busybox'])
const INTERPRETERS = new Set(['python', 'python3', 'python2', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'osascript', 'pwsh', 'powershell'])
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '-E', '-p', '-r', '--eval', '--print', '--command', '-Command'])
const WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'time', 'sudo', 'doas', 'nice', 'ionice', 'timeout', 'stdbuf', 'chronic', 'unbuffer', 'caffeinate', 'script', 'watch', 'flock', 'setsid', 'npx', 'pnpx', 'bunx'])
const RESERVED = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'case', 'esac', 'in', 'select', 'function', '[[', ']]'])
const HUMAN_ONLY = new Set(['approve', 'waive', 'stop', 'allow-force-push'])

/** Commands that destroy or overwrite every path argument. */
const WRITE_ALL_ARGS = new Set(['rm', 'rmdir', 'unlink', 'truncate', 'chmod', 'chown', 'chgrp', 'touch', 'tee', 'shred', 'mv', 'chattr', 'setfacl', 'xattr'])
/** Commands whose last argument is the destination. */
const WRITE_LAST_ARG = new Set(['cp', 'install', 'rsync', 'ln', 'scp'])

const KEYWORDS = /\b(commit|push|update-ref|commit-tree|hookspath|seaworthy|rebase|filter-branch|cherry-pick)\b|\.git\b|state\.json|\.github/i

/**
 * @param {string} path
 * @param {string[]} extra absolute paths that are also protected (key dir, plugin dir)
 */
export function isProtectedPath(path, extra = []) {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!p) return false
  if (/(^|\/)\.git(\/|$)/.test(p)) return true
  if (/(^|\/)\.seaworthy\.json$/.test(p)) return true
  if (/(^|\/)\.github\/workflows(\/|$)/.test(p)) return true
  if (/(^|\/)\.github$/.test(p)) return true
  for (const e of extra) {
    const x = e.replace(/\\/g, '/').replace(/\/+$/, '')
    if (p === x || p.startsWith(x + '/')) return true
  }
  return false
}

/**
 * Could a glob or a directory argument cover a protected path? (`.`, `..`, `.g*`, `.*`, `~`, `/`)
 * @param {string} arg
 */
function coversProtected(arg) {
  const a = arg.replace(/\\/g, '/').replace(/\/+$/, '')
  if (a === '.' || a === '..' || a === '' || a === '/' || a === '~' || /^(\.\.\/)+\.?\.?$/.test(a + '/')) return true
  if (/[*?[]/.test(a)) {
    const dir = a.includes('/') ? a.slice(0, a.lastIndexOf('/')) : '.'
    if (dir !== '.' && dir !== '' && dir !== '..' && !/^(\.\.\/)*\.\.$/.test(dir)) return false
    const re = new RegExp(
      '^' +
        a
          .split('/')
          .pop()
          ?.replace(/[.+^${}()|\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') +
        '$',
    )
    return ['.git', '.seaworthy.json', '.github'].some((n) => re.test(n))
  }
  return false
}

/** @param {string} w */
const base = (w) => w.replace(/\\/g, '/').split('/').pop() ?? w

/**
 * Strips assignments, reserved words and wrapper programs from the front of a command.
 * @param {import('./shell-parse.js').Word[]} words
 * @returns {{ words: import('./shell-parse.js').Word[], viaXargs: boolean, skip: boolean }}
 */
function unwrap(words) {
  let w = words.slice()
  let viaXargs = false
  for (let guard = 0; guard < 20 && w.length; guard++) {
    const head = w[0].text
    if (RESERVED.has(head)) {
      w = w.slice(1)
      continue
    }
    if (w[0].literal && /^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      w = w.slice(1)
      continue
    }
    const b = base(head)
    if (b === 'command' && (w[1]?.text === '-v' || w[1]?.text === '-V')) return { words: [], viaXargs, skip: true }
    if (b === 'xargs' || b === 'parallel') {
      viaXargs = true
      w = w.slice(1)
      while (w.length && w[0].text.startsWith('-')) {
        const flagTakesValue = /^-(I|L|n|P|s|d|E|a)$/.test(w[0].text) || /^--(replace|max-args|max-procs|delimiter|arg-file)$/.test(w[0].text)
        w = w.slice(flagTakesValue ? 2 : 1)
      }
      continue
    }
    if (WRAPPERS.has(b)) {
      w = w.slice(1)
      while (w.length && (w[0].text.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0].text) || (b === 'timeout' && /^\d/.test(w[0].text)) || (b === 'nice' && /^-?\d+$/.test(w[0].text)))) {
        const takesValue = (b === 'env' && /^-(u|C|S)$/.test(w[0].text)) || (b === 'sudo' && /^-(u|g|C|D|h|p|r|t|U)$/.test(w[0].text)) || (b === 'timeout' && /^-(s|k)$/.test(w[0].text)) || (b === 'flock' && /^-(w|E)$/.test(w[0].text))
        w = w.slice(takesValue ? 2 : 1)
      }
      if (b === 'flock' && w.length) w = w.slice(1)
      continue
    }
    break
  }
  return { words: w, viaXargs, skip: false }
}

/**
 * @param {string[]} argv words after `git`
 * @param {Record<string, string>} aliases
 * @returns {{ verb: string | null, rest: string[], globals: string[], configWrites: string[], aliasShell: string | null, viaAlias: boolean }}
 */
function parseGit(argv, aliases) {
  /** @type {string[]} */
  const globals = []
  /** @type {string[]} */
  const configWrites = []
  /** @type {Record<string, string>} */
  const inlineAliases = {}
  let i = 0
  while (i < argv.length && argv[i].startsWith('-')) {
    const a = argv[i]
    const eq = a.indexOf('=')
    const name = eq > 0 ? a.slice(0, eq) : a
    if (GIT_GLOBAL_WITH_VALUE.has(name)) {
      const value = eq > 0 ? a.slice(eq + 1) : argv[i + 1] ?? ''
      globals.push(`${name} ${value}`)
      if (name === '-c' || name === '--config-env') {
        const key = value.split('=')[0]
        configWrites.push(key)
        const m = value.match(/^alias\.([^=]+)=(.*)$/i)
        if (m) inlineAliases[m[1]] = m[2]
      }
      i += eq > 0 ? 1 : 2
      continue
    }
    globals.push(a)
    i++
  }
  let verb = argv[i] ?? null
  let rest = argv.slice(i + 1)
  let aliasShell = null
  let viaAlias = false
  const alias = verb ? inlineAliases[verb] ?? aliases[verb] : undefined
  if (verb && alias !== undefined) {
    if (alias.startsWith('!')) aliasShell = alias.slice(1)
    else {
      viaAlias = true
      const parts = alias.trim().split(/\s+/)
      verb = parts[0]
      rest = [...parts.slice(1), ...rest]
    }
  }
  return { verb, rest, globals, configWrites, aliasShell, viaAlias }
}

/**
 * Is this `git reset` invocation one that moves HEAD (a write) rather than just unstaging?
 * @param {string[]} rest
 */
function resetMovesHead(rest) {
  const dd = rest.indexOf('--')
  const before = dd >= 0 ? rest.slice(0, dd) : rest
  if (before.some((a) => /^--(hard|soft|keep|merge)$/.test(a))) return true
  const positional = before.filter((a) => !a.startsWith('-'))
  if (dd >= 0) return false
  return positional.length > 0 && positional.every((a) => /^(HEAD|@)?[~^]/.test(a) || /^[0-9a-f]{7,40}$/.test(a) || /^(origin\/|refs\/)/.test(a))
}

/**
 * Analyzes a Bash command line for git history writes, writes to protected paths and
 * human-only seaworthy commands. Anything it cannot read with confidence lands in `ambiguous`.
 * @param {string} cmd
 * @param {AnalyzeOptions} [opts]
 * @returns {Analysis}
 */
export function analyzeCommand(cmd, opts = {}) {
  /** @type {Analysis} */
  const out = { gitWrites: [], protectedWrites: [], seaworthy: [], humanOnly: [], ambiguous: [] }
  const extra = opts.protectedPaths ?? []
  const aliases = opts.aliases ?? {}
  const hasKeywords = KEYWORDS.test(cmd)

  /** @param {string} p */
  const checkPath = (p) => {
    if (isProtectedPath(p, extra) || coversProtected(p)) out.protectedWrites.push(p)
  }

  /**
   * @param {string} src
   * @param {number} depth
   * @param {boolean} nested inside sh -c, eval, substitutions, xargs, aliases…
   */
  const walk = (src, depth, nested) => {
    if (depth > 8) {
      out.ambiguous.push('nesting too deep')
      return
    }
    const parsed = parseShell(src, depth)
    if (parsed.ambiguous.length && (hasKeywords || depth > 0)) out.ambiguous.push(...parsed.ambiguous)
    for (const s of parsed.substitutions) walk(s, depth + 1, true)

    for (const c of parsed.commands) {
      for (const r of c.redirects) {
        if (/^(>|>>|>\||&>|&>>|<>)$/.test(r.op)) {
          if (!r.target.literal && KEYWORDS.test(r.target.text)) out.ambiguous.push(`computed redirect target ${r.target.text}`)
          checkPath(r.target.text)
        }
      }
      const { words, viaXargs, skip } = unwrap(c.words)
      if (skip || words.length === 0) continue
      const head = words[0]
      if (!head.literal) {
        if (hasKeywords || depth > 0) out.ambiguous.push(`computed command name ${head.text}`)
        continue
      }
      const name = base(head.text)
      const args = words.slice(1).map((w) => w.text)
      const isNested = nested || viaXargs || c.background || c.depth > 0

      if (SHELLS.has(name)) {
        const ci = args.findIndex((a) => a === '-c' || /^-[a-z]*c$/.test(a))
        if (ci >= 0 && args[ci + 1] !== undefined) walk(args[ci + 1], depth + 1, true)
        else if (c.heredoc !== null) walk(c.heredoc, depth + 1, true)
        else if (args.length === 0 || args.every((a) => a.startsWith('-'))) {
          if (hasKeywords) out.ambiguous.push(`${name} reading commands from stdin`)
        }
        continue
      }
      if (name === 'eval' || name === 'source' || name === '.') {
        if (name === 'eval') walk(args.join(' '), depth + 1, true)
        continue
      }
      if (name === 'alias') {
        for (const a of args) {
          const m = a.match(/^[^=]+=(.*)$/)
          if (m) walk(m[1], depth + 1, true)
        }
        continue
      }
      if (name === 'seaworthy' || (name === 'node' && /seaworthy\/core\/cli\.js$|core\/cli\.js$/.test(args[0] ?? '')) || /\/bin\/seaworthy$/.test(head.text)) {
        const swArgs = name === 'node' ? args.slice(1) : args
        const sub = swArgs[0] ?? ''
        out.seaworthy.push({ sub, argv: swArgs.slice(1) })
        if (HUMAN_ONLY.has(sub) || (sub === 'init' && swArgs.includes('--force'))) out.humanOnly.push(`seaworthy ${swArgs.join(' ')}`)
        continue
      }
      if (INTERPRETERS.has(name.replace(/\d+(\.\d+)*$/, '')) || INTERPRETERS.has(name)) {
        const fi = args.findIndex((a) => INLINE_CODE_FLAGS.has(a))
        const code = fi >= 0 ? args[fi + 1] ?? '' : c.heredoc ?? ''
        if (code) {
          if (/\bgit\b/.test(code) && /\b(commit|push|update-ref|commit-tree|rebase|reset|merge|cherry-pick|config|filter-branch)\b/.test(code))
            out.gitWrites.push({ verb: 'inline-code', argv: [code], canonical: false, globals: [] })
          for (const m of code.matchAll(/['"`]([^'"`]+)['"`]/g)) if (isProtectedPath(m[1], extra)) out.protectedWrites.push(m[1])
          if (/\.git\/|\.seaworthy\.json|\.github\/workflows/.test(code) && !out.protectedWrites.length) out.protectedWrites.push('(inline code naming a protected path)')
        }
        continue
      }
      if (name === 'find') {
        const ei = args.findIndex((a) => a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir')
        if (ei >= 0) {
          const end = args.findIndex((a, k) => k > ei && (a === ';' || a === '+' || a === '\\;'))
          walk(args.slice(ei + 1, end < 0 ? undefined : end).join(' '), depth + 1, true)
        }
        if (args.includes('-delete') || ei >= 0) {
          const firstFlag = args.findIndex((a) => a.startsWith('-'))
          const roots = args.slice(0, firstFlag < 0 ? args.length : firstFlag)
          for (const r of roots) if (isProtectedPath(r, extra)) out.protectedWrites.push(r)
          if (/\.git\b|seaworthy|state\.json|\.github/.test(args.join(' '))) out.protectedWrites.push(`find ${args.join(' ')}`)
        }
        continue
      }
      if (name === 'git') {
        const g = parseGit(args, aliases)
        if (g.aliasShell !== null) {
          walk(g.aliasShell, depth + 1, true)
          continue
        }
        const sensitiveGlobal = g.globals.some((x) => /^(-c|--config-env) /.test(x) && SENSITIVE_CONFIG.test(x.split(' ')[1]))
        const otherRepo = g.globals.some((x) => /^(--git-dir|--work-tree) /.test(x) || (/^-C /.test(x) && !/^-C \.?\/?$/.test(x)))
        if (!g.verb) continue
        if (!words.slice(1).every((w) => w.literal) && /commit|push|config|update-ref|reset|rebase/.test(g.verb + ' ' + g.rest.join(' ')))
          out.ambiguous.push(`computed git arguments: git ${args.join(' ')}`)
        if (g.verb === 'config') {
          const keyArg = g.rest.find((a) => !a.startsWith('-'))
          const reading = g.rest.some((a) => /^(--get|--get-all|--get-regexp|-l|--list|--show-origin|--show-scope|get)$/.test(a)) || g.rest.filter((a) => !a.startsWith('-')).length < 2
          if (keyArg && SENSITIVE_CONFIG.test(keyArg) && !reading) out.gitWrites.push({ verb: 'config', argv: g.rest, canonical: false, globals: g.globals })
          continue
        }
        if (g.verb === 'stash') {
          if (g.rest[0] === 'apply' || g.rest[0] === 'pop') {
            /* touches the working tree only */
          }
          continue
        }
        if (g.verb === 'reset' && !resetMovesHead(g.rest)) {
          for (const a of g.rest.slice(g.rest.indexOf('--') + 1)) if (isProtectedPath(a, extra)) out.protectedWrites.push(a)
          continue
        }
        if (g.verb === 'checkout' || g.verb === 'restore' || g.verb === 'rm' || g.verb === 'mv' || g.verb === 'clean') {
          for (const a of g.rest) if (!a.startsWith('-') && (isProtectedPath(a, extra) || (g.verb !== 'checkout' && coversProtected(a)))) out.protectedWrites.push(a)
          if (g.verb === 'clean' && g.rest.some((a) => /^-[a-zA-Z]*x/.test(a))) out.protectedWrites.push('git clean -x')
          continue
        }
        if (g.verb === 'branch' && g.rest.some((a) => /^(-f|--force|-M|-C)$/.test(a))) {
          out.gitWrites.push({ verb: 'branch-force', argv: g.rest, canonical: false, globals: g.globals })
          continue
        }
        if (g.verb === 'tag' || g.verb === 'fetch' || g.verb === 'status' || g.verb === 'log' || g.verb === 'diff' || g.verb === 'show') continue
        if (GIT_WRITE_VERBS.has(g.verb)) {
          const canonical = !isNested && !g.viaAlias && !sensitiveGlobal && !otherRepo && g.globals.length === 0 && (g.verb === 'commit' || g.verb === 'push') && words.every((w) => w.literal)
          out.gitWrites.push({ verb: g.verb, argv: g.rest, canonical, globals: g.globals })
        } else if (sensitiveGlobal) {
          out.gitWrites.push({ verb: `${g.verb} (with -c)`, argv: g.rest, canonical: false, globals: g.globals })
        }
        continue
      }
      if (name === 'sed' || name === 'perl' || name === 'ruby') {
        const inPlace = args.some((a) => /^(-i|--in-place)/.test(a) || /^-[a-zA-Z]*i/.test(a))
        if (inPlace) for (const a of args) if (!a.startsWith('-') && (isProtectedPath(a, extra) || coversProtected(a))) out.protectedWrites.push(a)
        continue
      }
      if (name === 'dd') {
        for (const a of args) if (a.startsWith('of=')) checkPath(a.slice(3))
        continue
      }
      if (WRITE_ALL_ARGS.has(name)) {
        for (const a of args) if (!a.startsWith('-') || a === '-') checkPath(a)
        continue
      }
      if (WRITE_LAST_ARG.has(name)) {
        const pos = args.filter((a) => !a.startsWith('-'))
        if (pos.length) checkPath(pos[pos.length - 1])
        const t = args.findIndex((a) => a === '-t' || a === '--target-directory')
        if (t >= 0 && args[t + 1]) checkPath(args[t + 1])
        continue
      }
    }
  }

  walk(cmd, 0, false)
  out.protectedWrites = [...new Set(out.protectedWrites)]
  out.ambiguous = [...new Set(out.ambiguous)]
  return out
}

/**
 * Does the analysis contain anything a seaworthy session must refuse outright?
 * (Canonical `git commit` / `git push` go on to the commit and push gates instead.)
 * @param {Analysis} a
 */
export function hardViolations(a) {
  /** @type {string[]} */
  const reasons = []
  for (const p of a.protectedWrites) reasons.push(`writes to protected path ${p}`)
  for (const h of a.humanOnly) reasons.push(`\`${h}\` can only be run by the developer`)
  for (const g of a.gitWrites)
    if (!g.canonical) reasons.push(g.verb === 'commit' || g.verb === 'push' ? `non-canonical git ${g.verb} (use plain \`git ${g.verb} …\` with no wrappers, -c or -C)` : `git ${g.verb} is not allowed during a seaworthy session`)
  for (const x of a.ambiguous) reasons.push(`cannot read this command safely: ${x}`)
  return reasons
}
