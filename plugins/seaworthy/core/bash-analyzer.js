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
 *   dangerousEnv: string[],
 *   protectedRefs: string[],
 *   scripts: string[],
 *   maybeScripts: string[],
 *   packageScripts: string[],
 * }} Analysis
 * @typedef {{
 *   protectedPaths?: string[],
 *   hiddenPaths?: string[],
 *   aliases?: Record<string, string>,
 *   resolve?: (p: string) => string | null,
 * }} AnalyzeOptions
 */

/** Git subcommands that write history, refs or config. */
const GIT_WRITE_VERBS = new Set([
  'commit', 'commit-tree', 'push', 'update-ref', 'symbolic-ref', 'rebase', 'merge', 'cherry-pick', 'revert',
  'am', 'apply-mailbox', 'filter-branch', 'filter-repo', 'replace', 'notes', 'fast-import', 'pull', 'reset', 'config',
])
/**
 * Git subcommands that are safe during a session: they read, or change only the index, the working
 * tree or local refs at commits that already exist (the reference-transaction backstop checks the
 * rest). Every other subcommand — plumbing such as send-pack, receive-pack, fast-import, anything
 * unknown or added by a plugin — is treated as a write and refused. An allow-list, because a
 * deny-list of writes misses the ones nobody thought of (send-pack did).
 */
const GIT_SAFE_VERBS = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'annotate', 'grep', 'ls-files', 'ls-tree', 'ls-remote', 'rev-parse', 'rev-list', 'cat-file',
  'describe', 'shortlog', 'reflog', 'name-rev', 'merge-base', 'for-each-ref', 'show-ref', 'show-branch', 'count-objects', 'check-ignore',
  'check-attr', 'check-ref-format', 'check-mailmap', 'var', 'version', 'help', 'whatchanged', 'range-diff', 'format-patch', 'request-pull',
  'archive', 'diff-tree', 'diff-files', 'diff-index', 'difftool', 'cherry', 'verify-commit', 'verify-tag', 'fsck', 'hash-object', 'write-tree',
  'mktree', 'add', 'stage', 'rm', 'mv', 'restore', 'checkout', 'switch', 'branch', 'tag', 'stash', 'fetch', 'clean', 'apply', 'worktree',
  'sparse-checkout', 'submodule', 'bisect', 'gc', 'maintenance', 'prune', 'repack', 'update-index', 'read-tree', 'checkout-index', 'remote',
  'bundle', 'interpret-trailers', 'column', 'show-index', 'lfs', 'mergetool',
])
/** `git config` keys that change who commits or which hooks run. */
const SENSITIVE_CONFIG = /^(core\.hookspath|user\.|author\.|committer\.|alias\.|include\.|includeif\.|commit\.template|trailer\.|core\.editor|sequence\.editor|gpg\.)/i
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'busybox'])
const INTERPRETERS = new Set(['python', 'python3', 'python2', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'osascript', 'pwsh', 'powershell', 'lua', 'luajit', 'Rscript', 'julia', 'tclsh', 'expect', 'wish'])
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '-E', '-p', '-r', '--eval', '--print', '--command', '-Command'])
const WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'time', 'sudo', 'doas', 'nice', 'ionice', 'timeout', 'stdbuf', 'chronic', 'unbuffer', 'caffeinate', 'flock', 'setsid', 'npx', 'pnpx', 'bunx'])
const RESERVED = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'case', 'esac', 'in', 'select', 'function', '[[', ']]'])
const HUMAN_ONLY = new Set(['approve', 'waive', 'stop', 'allow-force-push', 'claim', 'githook', 'hook'])

/** Commands that destroy or overwrite every path argument. */
const WRITE_ALL_ARGS = new Set(['rm', 'rmdir', 'unlink', 'truncate', 'chmod', 'chown', 'chgrp', 'touch', 'tee', 'shred', 'mv', 'chattr', 'setfacl', 'xattr', 'ln'])
/** Commands whose last argument is the destination. */
const WRITE_LAST_ARG = new Set(['cp', 'install', 'rsync', 'scp'])

/** Environment variables that redirect git, the checks or the shell. Never allowed during a session. */
const DANGEROUS_ENV = /^(GIT_[A-Z0-9_]+|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_[A-Z_]+|BASH_ENV|ENV|PATH|SHELLOPTS|PYTHONPATH|PYTHONSTARTUP|RUBYOPT|PERL5OPT|PERL5LIB|SEAWORTHY_[A-Z_]+|XDG_CONFIG_HOME|HOME|PROMPT_COMMAND)$/
/** Paths the agent may not even read: the HMAC key, the plugin, the core copy git hooks run. */
const HIDDEN = /\.config\/seaworthy|\.git\/seaworthy-core/i
const SCRIPT_RUNNERS = new Set(['node', 'nodejs', 'deno', 'bun', 'tsx', 'ts-node', 'vite-node', 'esno', 'python', 'python3', 'python2', 'ruby', 'perl', 'php', 'pwsh', 'powershell', 'osascript', 'lua', 'luajit', 'Rscript', 'julia', 'tclsh', 'expect', 'wish'])
/** bun / deno subcommands that do not take a script path as their first positional. */
const RUNTIME_SUBCOMMANDS = new Set(['test', 'x', 'install', 'i', 'add', 'remove', 'rm', 'update', 'upgrade', 'outdated', 'link', 'unlink', 'pm', 'init', 'create', 'build', 'fmt', 'lint', 'check', 'bench', 'doc', 'info', 'repl', 'types', 'completions', 'compile', 'coverage', 'publish', 'serve', 'jupyter', 'help'])
/**
 * Inline code (`python -c`, `node -e`, `perl -e` …) that starts processes or decodes / evaluates
 * code cannot be read with confidence: refuse it instead of guessing what it runs.
 */
const OPAQUE_CODE = /\b(child_process|exec(File)?Sync|spawnSync|execa|subprocess|os\.(system|popen|exec\w*|spawn\w*|fork)|popen|pty\.spawn|commands\.getoutput|system\s*\(|shell_exec|passthru|proc_open|IO\.popen|Open3|Kernel\.(exec|system|spawn)|Process\.(spawn|exec)|Deno\.(run|Command)|Bun\.(spawn|\$)|run\s*\(\s*`|eval\s*\(|exec\s*\(|Function\s*\(|b64decode|base64|atob\s*\(|fromCharCode|codecs\.decode|__import__|importlib|compile\s*\()|`|\bqx\b|%x[({\[]/
/** A shell function definition: `f() {`, `function f {`. */
const FUNCTION_DEF = /(^|[;&|\n({]\s*)(function\s+[A-Za-z_][\w.:-]*\s*(\(\s*\))?|[A-Za-z_][\w.:-]*\s*\(\s*\))\s*[{(]/
/** sed scripts that execute commands (GNU `e` command, `s///e` flag). */
const SED_EXEC = /(^|[;\n{}]|[0-9$])\s*e(\s|;|$)|s(.)(?:\\.|(?!\3).)*\3(?:\\.|(?!\3).)*\3[a-zA-Z0-9]*e/
/** tar options that run a program. */
const TAR_EXEC = /^(--checkpoint-action|--to-command|--use-compress-program|--info-script|--new-volume-script|--rsh-command|--rmt-command|-I|-F)(=|$)/
const NODE_LOAD_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader'])
const PM_BUILTINS = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'ci', 'exec', 'dlx', 'x', 'create', 'init', 'link', 'unlink', 'publish', 'pack', 'outdated', 'list', 'ls', 'why', 'audit', 'config', 'set', 'get', 'info', 'view', 'login', 'logout', 'whoami', 'cache', 'store', 'prune', 'dedupe', 'rebuild', 'help', 'version', '-v', '--version'])

const KEYWORDS = /\b(commit|push|update-ref|commit-tree|hookspath|seaworthy|rebase|filter-branch|cherry-pick)\b|\.git\b|state\.json|\.github/i

/**
 * @param {string} path
 * @param {string[]} extra absolute paths that are also protected (key dir, plugin dir)
 */
export function isProtectedPath(path, extra = []) {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  if (!p) return false
  if (/(^|\/)node_modules\/\.bin(\/|$)/.test(p)) return true
  if (/(^|\/)\.git(\/|$)/.test(p)) return true
  if (/(^|\/)\.seaworthy\.json$/.test(p)) return true
  if (/(^|\/)\.github\/workflows(\/|$)/.test(p)) return true
  if (/(^|\/)\.github$/.test(p)) return true
  for (const e of extra) {
    const x = e.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
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
    if (!(a.split('/').pop() ?? '').startsWith('.') && !(a.split('/').pop() ?? '').startsWith('[')) return false
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

/** Re-quotes words for re-parsing (`find -exec sh -c 'a b'` must stay one argument). @param {string[]} words */
const requote = (words) => words.map((a) => (/^[\w@%+=:,./{}^~-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')

/**
 * Strips assignments, reserved words and wrapper programs from the front of a command.
 * @param {import('./shell-parse.js').Word[]} words
 * @returns {{ words: import('./shell-parse.js').Word[], viaXargs: boolean, skip: boolean, assigns: string[], inner: string[] }}
 */
function unwrap(words) {
  let w = words.slice()
  let viaXargs = false
  /** @type {string[]} */
  const assigns = []
  /** @type {string[]} command strings a wrapper runs through its own parsing (`env -S`) */
  const inner = []
  for (let guard = 0; guard < 20 && w.length; guard++) {
    const head = w[0].text
    if (RESERVED.has(head)) {
      w = w.slice(1)
      continue
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      assigns.push(head.split('=')[0])
      w = w.slice(1)
      continue
    }
    const b = base(head)
    if (b === 'command' && (w[1]?.text === '-v' || w[1]?.text === '-V')) return { words: [], viaXargs, skip: true, assigns, inner }
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
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0].text)) assigns.push(w[0].text.split('=')[0])
        if (b === 'env' && (w[0].text === '-S' || w[0].text === '--split-string') && w[1]) inner.push([w[1].text, ...w.slice(2).map((x) => x.text)].join(' '))
        if (b === 'env' && /^--split-string=/.test(w[0].text)) inner.push(w[0].text.slice('--split-string='.length))
        const takesValue = (b === 'env' && /^-(u|C|S)$/.test(w[0].text)) || (b === 'sudo' && /^-(u|g|C|D|h|p|r|t|U)$/.test(w[0].text)) || (b === 'timeout' && /^-(s|k)$/.test(w[0].text)) || (b === 'flock' && /^-(w|E)$/.test(w[0].text))
        w = w.slice(takesValue ? 2 : 1)
      }
      if (b === 'flock' && w.length) w = w.slice(1)
      continue
    }
    break
  }
  if (inner.length) return { words: [], viaXargs, skip: false, assigns, inner }
  return { words: w, viaXargs, skip: false, assigns, inner }
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
  const out = { gitWrites: [], protectedWrites: [], seaworthy: [], humanOnly: [], ambiguous: [], dangerousEnv: [], protectedRefs: [], scripts: [], maybeScripts: [], packageScripts: [] }
  const extra = opts.protectedPaths ?? []
  const hidden = (opts.hiddenPaths ?? []).map((h) => h.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()).filter(Boolean)
  const aliases = opts.aliases ?? {}
  const hasKeywords = KEYWORDS.test(cmd)

  /** @param {string} p */
  const checkPath = (p) => {
    if (isProtectedPath(p, extra) || coversProtected(p)) out.protectedWrites.push(p)
    else if (opts.resolve) {
      const r = opts.resolve(p)
      if (r && isProtectedPath(r, extra)) out.protectedWrites.push(`${p} (→ ${r})`)
    }
  }
  /** @param {string} text */
  const checkHidden = (text) => {
    const t = text.replace(/\\/g, '/').toLowerCase()
    if (HIDDEN.test(t) || hidden.some((h) => t.includes(h))) out.protectedRefs.push(text.length > 80 ? text.slice(0, 77) + '…' : text)
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
    // A function hides what its callers run (`g() { git "$@"; }; g update-ref …`).
    if (FUNCTION_DEF.test(src)) out.ambiguous.push('shell function definition (run the commands directly)')
    for (const s of parsed.substitutions) walk(s, depth + 1, true)

    for (const c of parsed.commands) {
      for (const w of c.words) checkHidden(w.text)
      for (const r of c.redirects) checkHidden(r.target.text)
      if (c.heredoc) checkHidden(c.heredoc)
      for (const r of c.redirects) {
        if (/^(>|>>|>\||&>|&>>|<>)$/.test(r.op)) {
          if (!r.target.literal && KEYWORDS.test(r.target.text)) out.ambiguous.push(`computed redirect target ${r.target.text}`)
          checkPath(r.target.text)
        }
      }
      const { words, viaXargs, skip, assigns, inner } = unwrap(c.words)
      for (const n of assigns) if (DANGEROUS_ENV.test(n)) out.dangerousEnv.push(n)
      for (const x of inner) walk(x, depth + 1, true)
      if (skip || words.length === 0) continue
      const head = words[0]
      if (!head.literal) {
        if (hasKeywords || depth > 0) out.ambiguous.push(`computed command name ${head.text}`)
        continue
      }
      const name = base(head.text)
      const args = words.slice(1).map((w) => w.text)
      const isNested = nested || viaXargs || c.background || c.depth > 0

      if (name === 'export' || name === 'declare' || name === 'typeset' || name === 'readonly' || name === 'set' || name === 'setenv' || name === 'unset') {
        for (const a of args) {
          const n = a.split('=')[0]
          if (DANGEROUS_ENV.test(n)) out.dangerousEnv.push(n)
        }
        continue
      }
      if (SHELLS.has(name)) {
        const ci = args.findIndex((a) => a === '-c' || /^-[a-z]*c$/.test(a))
        if (ci >= 0 && args[ci + 1] !== undefined) walk(args[ci + 1], depth + 1, true)
        else if (c.heredoc !== null) walk(c.heredoc, depth + 1, true)
        else {
          const file = args.find((a) => !a.startsWith('-'))
          if (file) out.scripts.push(file)
          // `… | base64 -d | sh`, `… | rev | bash`: what runs is not on the command line at all.
          else out.ambiguous.push(`${name} reading commands from stdin`)
        }
        continue
      }
      if (head.text.includes('/') && !['git', 'seaworthy'].includes(name)) {
        out.scripts.push(head.text)
      }
      if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
        const pos = args.filter((a) => !a.startsWith('-'))
        const sub = pos[0]
        if (sub === 'exec' || sub === 'x' || sub === 'dlx') {
          // `npm exec -c '<cmd>'`, `pnpm exec git …`: the command is right there — read it.
          const ci = args.findIndex((a) => a === '-c' || a === '--call')
          const eq = args.find((a) => a.startsWith('--call='))
          if (ci >= 0 && args[ci + 1] !== undefined) walk(args[ci + 1], depth + 1, true)
          else if (eq) walk(eq.slice('--call='.length), depth + 1, true)
          else {
            const si = args.indexOf(sub)
            const rest = args.slice(si + 1).filter((a, k, all) => !(a.startsWith('-') && !all.slice(0, k).includes('--')) && a !== '--')
            if (rest.length) walk(requote(rest), depth + 1, true)
          }
          continue
        }
        if (sub === 'run' || sub === 'run-script') {
          if (pos[1]) out.packageScripts.push(pos[1])
        } else if (sub === 'test' || sub === 't' || sub === 'tst') out.packageScripts.push('test')
        else if (sub === 'start' || sub === 'stop' || sub === 'restart') out.packageScripts.push(sub)
        else if (sub && name !== 'npm' && !PM_BUILTINS.has(sub)) out.packageScripts.push(sub)
        continue
      }
      if (name === 'eval' || name === 'source' || name === '.') {
        if (name === 'eval') walk(args.join(' '), depth + 1, true)
        else if (args[0]) out.scripts.push(args[0]) // sourcing a file runs it: same rules as a script
        else out.ambiguous.push(`${name} without a file`)
        continue
      }
      if (name === 'trap') {
        const pos = args.filter((a) => a !== '--' && !/^-[lp]+$/.test(a))
        if (pos.length >= 2 && pos[0] !== '-' && pos[0] !== '') walk(pos[0], depth + 1, true)
        continue
      }
      if (name === 'script') {
        const ci = args.findIndex((a) => a === '-c' || a === '--command' || /^-[a-zA-Z]*c$/.test(a))
        const eq = args.find((a) => a.startsWith('--command='))
        if (ci >= 0 && args[ci + 1] !== undefined) walk(args[ci + 1], depth + 1, true)
        else if (eq) walk(eq.slice('--command='.length), depth + 1, true)
        else out.ambiguous.push('script without -c starts an interactive shell')
        continue
      }
      if (name === 'watch') {
        let k = 0
        while (k < args.length && args[k].startsWith('-')) k += /^-(n|d|g|q|c|x)$/.test(args[k]) && /^-(n)$/.test(args[k]) ? 2 : 1
        // watch joins its arguments with spaces and hands them to `sh -c`, so a plain join is exact.
        if (args[k]) walk(args.slice(k).join(' '), depth + 1, true)
        continue
      }
      if (name === 'awk' || name === 'gawk' || name === 'mawk' || name === 'nawk') {
        const fi = args.findIndex((a) => a === '-f' || a === '--file')
        if (fi >= 0 && args[fi + 1]) out.scripts.push(args[fi + 1])
        let k = 0
        while (k < args.length && args[k].startsWith('-')) k += /^-(f|v|F|i|l|E)$/.test(args[k]) ? 2 : 1
        const prog = fi >= 0 ? '' : args[k] ?? ''
        if (/\bsystem\s*\(|\|\s*getline|["')]\s*\|\s*["(]|\|&|print\s*[^;]*\|\s*"/.test(prog)) out.ambiguous.push('awk program that runs commands')
        continue
      }
      if (name === 'tar' || name === 'bsdtar' || name === 'gtar') {
        if (args.some((a) => TAR_EXEC.test(a))) out.ambiguous.push('tar option that runs a program')
        continue
      }
      if (name === 'make' || name === 'gmake' || name === 'bmake') {
        let file = false
        for (let k = 0; k < args.length; k++) {
          const m = args[k].match(/^(?:-f|--file|--makefile)(?:=(.+))?$/)
          if (m) {
            const f = m[1] ?? args[k + 1]
            if (f) out.scripts.push(f)
            file = true
          }
        }
        // The default makefile is a script too: an edited one cannot be run.
        if (!file) out.maybeScripts.push('GNUmakefile', 'makefile', 'Makefile')
        continue
      }
      if (['vi', 'vim', 'nvim', 'view', 'ex', 'emacs', 'nano', 'less', 'more', 'man'].includes(name)) {
        if (args.some((a) => /^(-c|-S|--cmd|--eval|-l|--load|-x|--script)$/.test(a) || /^\+/.test(a))) out.ambiguous.push(`${name} running editor commands`)
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
        const runner = name.replace(/\d+(\.\d+)*$/, '')
        // `-e`, and combined short flags ending in it (`perl -ne`, `ruby -pe`, `node -pe`).
        const fi = args.findIndex((a) => INLINE_CODE_FLAGS.has(a) || (['perl', 'ruby', 'node', 'nodejs'].includes(runner) && /^-[a-zA-Z]+e$/.test(a)))
        const code = fi >= 0 ? args[fi + 1] ?? '' : c.heredoc ?? ''
        for (let k = 0; k < args.length; k++) {
          if (NODE_LOAD_FLAGS.has(args[k]) && args[k + 1] && /^[./~]/.test(args[k + 1])) out.scripts.push(args[k + 1])
          const eq = args[k].match(/^--(require|import|loader|experimental-loader)=(.+)$/)
          if (eq && /^[./~]/.test(eq[2])) out.scripts.push(eq[2])
        }
        if (fi < 0 && SCRIPT_RUNNERS.has(runner || name)) {
          let k = 0
          while (k < args.length && args[k].startsWith('-')) k += NODE_LOAD_FLAGS.has(args[k]) || args[k] === '-m' ? 2 : 1
          // `node --test [globs…]`: the positionals are test files or globs, run the way `npm test` runs them.
          const testMode = args.some((a) => a === '--test' || a.startsWith('--test='))
          // `bun test`, `deno fmt` …: a subcommand, not a script; `bun run x.ts` / `deno run x.ts`: the next one is.
          const subcommand = (runner === 'bun' || runner === 'deno') && Boolean(args[k]) && RUNTIME_SUBCOMMANDS.has(args[k])
          if (subcommand) k = args.length
          else if ((runner === 'bun' || runner === 'deno') && args[k] === 'run') {
            k++
            while (k < args.length && args[k].startsWith('-')) k++
          }
          const module = args.includes('-m') // `python -m pkg args`: an installed module, its args are data
          if (testMode || subcommand || module) {
            /* test targets, a runtime subcommand, or a module: no script path */
          } else if (args[k] && args[k] !== '-') out.scripts.push(args[k])
          else if (!code && !args.some((a) => /^(-m|--version|-V|-v|--help|-h|--check|--print-config)$/.test(a)) && (args[k] === '-' || !args[k]) && c.heredoc === null)
            out.ambiguous.push(`${name} reading code from stdin`)
        }
        if (code && /seaworthy|\.config|state\.json|integrity|hookspath|\.git\/hooks/i.test(code)) out.protectedRefs.push('(inline code touching seaworthy, git hooks or ~/.config)')
        if (code) {
          if (/\bgit\b/.test(code) && /\b(commit|push|update-ref|commit-tree|rebase|reset|merge|cherry-pick|config|filter-branch|send-pack)\b/.test(code))
            out.gitWrites.push({ verb: 'inline-code', argv: [code], canonical: false, globals: [] })
          else if (OPAQUE_CODE.test(code)) out.ambiguous.push(`inline ${name} code that starts processes or decodes code (put it in a project script, or run the command directly)`)
          for (const m of code.matchAll(/['"`]([^'"`]+)['"`]/g)) if (isProtectedPath(m[1], extra)) out.protectedWrites.push(m[1])
          if (/\.git\/|\.seaworthy\.json|\.github\/workflows/.test(code) && !out.protectedWrites.length) out.protectedWrites.push('(inline code naming a protected path)')
        }
        continue
      }
      if (name === 'find') {
        const ei = args.findIndex((a) => a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir')
        if (ei >= 0) {
          const end = args.findIndex((a, k) => k > ei && (a === ';' || a === '+' || a === '\\;'))
          walk(requote(args.slice(ei + 1, end < 0 ? undefined : end)), depth + 1, true)
        }
        if (args.includes('-delete')) {
          const firstFlag = args.findIndex((a) => a.startsWith('-'))
          const roots = args.slice(0, firstFlag < 0 ? args.length : firstFlag)
          for (const r of roots) if (isProtectedPath(r, extra)) out.protectedWrites.push(r)
          if (/seaworthy|state\.json|hooks|workflows/.test(args.join(' '))) out.protectedWrites.push(`find ${args.join(' ')}`)
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
          const SUBS = new Set(['set', 'unset', 'get', 'list', 'edit', 'rename-section', 'remove-section', 'get-regexp', 'get-urlmatch', 'get-color', 'get-colorbool'])
          const VALUE_FLAGS = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value', '--url'])
          let sub = null
          /** @type {string[]} */
          const pos = []
          for (let k = 0; k < g.rest.length; k++) {
            const a = g.rest[k]
            if (VALUE_FLAGS.has(a)) {
              k++
              continue
            }
            if (a.startsWith('-')) continue
            if (sub === null && pos.length === 0 && SUBS.has(a)) sub = a
            else pos.push(a)
          }
          const writeFlag = g.rest.some((a) => /^(--unset|--unset-all|--replace-all|--add|-e|--edit|--rename-section|--remove-section)$/.test(a))
          const readFlag = g.rest.some((a) => /^(--get|--get-all|--get-regexp|--get-urlmatch|-l|--list|--show-origin|--show-scope)$/.test(a))
          const write = writeFlag || ['set', 'unset', 'edit', 'rename-section', 'remove-section'].includes(sub ?? '') || (!readFlag && sub === null && pos.length >= 2)
          const key = pos[0] ?? ''
          if (write && (SENSITIVE_CONFIG.test(key) || /^(edit|rename-section|remove-section)$/.test(sub ?? '') || g.rest.some((a) => /^(-e|--edit|--rename-section|--remove-section)$/.test(a))))
            out.gitWrites.push({ verb: 'config', argv: g.rest, canonical: false, globals: g.globals })
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
          for (const a of g.rest) if (!a.startsWith('-') && (isProtectedPath(a, extra) || (g.verb !== 'checkout' && g.verb !== 'restore' && coversProtected(a)))) out.protectedWrites.push(a)
          if (g.verb === 'clean' && g.rest.some((a) => /^-[a-zA-Z]*x/.test(a))) out.protectedWrites.push('git clean -x')
          continue
        }
        if (g.verb === 'branch' && g.rest.some((a) => /^(-f|--force|-M|-C)$/.test(a))) {
          out.gitWrites.push({ verb: 'branch-force', argv: g.rest, canonical: false, globals: g.globals })
          continue
        }
        if (/[$`]/.test(g.verb) || (args.includes(g.verb) && !words[1 + args.indexOf(g.verb)]?.literal)) {
          out.ambiguous.push(`computed git subcommand ${g.verb}`)
          continue
        }
        const firstPos = g.rest.find((a) => !a.startsWith('-')) ?? ''
        // Sub-modes of "safe" commands that write where seaworthy cannot follow.
        const unsafeMode =
          (g.verb === 'fetch' && g.rest.some((a) => !a.startsWith('-') && a.includes(':'))) || // fetch into a local ref
          (g.verb === 'remote' && /^(add|set-url|rename|remove|rm)$/.test(firstPos)) || // redirect where pushes go
          (g.verb === 'worktree' && /^(add|move)$/.test(firstPos)) // a worktree without session state
        if (GIT_SAFE_VERBS.has(g.verb) && !unsafeMode) {
          if (sensitiveGlobal) out.gitWrites.push({ verb: `${g.verb} (with -c)`, argv: g.rest, canonical: false, globals: g.globals })
          continue
        }
        const canonical = !isNested && !g.viaAlias && !sensitiveGlobal && !otherRepo && g.globals.length === 0 && (g.verb === 'commit' || g.verb === 'push') && words.every((w) => w.literal)
        out.gitWrites.push({ verb: unsafeMode ? `${g.verb} ${g.rest.join(' ')}`.slice(0, 60) : g.verb, argv: g.rest, canonical, globals: g.globals })
        continue
      }
      if (name === 'sed' || name === 'gsed') {
        /** @type {string[]} */
        const scripts = []
        let explicit = false
        for (let k = 0; k < args.length; k++) {
          const a = args[k]
          if (a === '-e' || a === '--expression') (scripts.push(args[k + 1] ?? ''), (explicit = true), k++)
          else if (a.startsWith('--expression=')) (scripts.push(a.slice(13)), (explicit = true))
          else if (a === '-f' || a === '--file') (args[k + 1] && out.scripts.push(args[k + 1]), (explicit = true), k++)
        }
        if (!explicit) {
          const first = args.find((a) => !a.startsWith('-'))
          if (first !== undefined) scripts.push(first)
        }
        for (const sc of scripts) {
          if (SED_EXEC.test(sc)) out.ambiguous.push('sed script that executes commands')
          for (const m of sc.matchAll(/(?:^|[;\n}]|\/[a-zA-Z0-9]*)\s*[wW]\s+(\S+)/g)) checkPath(m[1])
        }
      }
      if (name === 'sed' || name === 'gsed' || name === 'perl' || name === 'ruby') {
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
  for (const n of [...new Set(a.dangerousEnv)]) reasons.push(`setting ${n} is not allowed during a session (it can redirect git, the checks or the shell)`)
  for (const r of [...new Set(a.protectedRefs)]) reasons.push(`${r} is seaworthy's own machinery and cannot be read or run directly; use the \`seaworthy\` command`)
  return reasons
}
