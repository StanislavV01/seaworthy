// @ts-check

/**
 * A small, conservative shell tokenizer. It is not a full POSIX parser: its job is to find every
 * command a line could run (including inside `$(…)`, backticks, `sh -c`, here-documents) and to
 * say "ambiguous" whenever it cannot be sure, so the caller can refuse.
 *
 * @typedef {{ text: string, literal: boolean }} Word
 * @typedef {{ op: string, target: Word }} Redirect
 * @typedef {{
 *   words: Word[],
 *   redirects: Redirect[],
 *   heredoc: string | null,
 *   background: boolean,
 *   depth: number,
 * }} SimpleCommand
 * @typedef {{ commands: SimpleCommand[], substitutions: string[], ambiguous: string[] }} Parsed
 */

const OPS = ['&&', '||', '|&', ';;', ';', '|', '&', '(', ')', '\n']
const REDIRECTS = ['&>>', '&>', '>>', '>|', '<<<', '<<-', '<<', '<&', '>&', '<>', '>', '<']

/**
 * Finds the end of a `$(`…`)` / `<(`…`)` body starting right after the opening paren.
 * @param {string} s
 * @param {number} i index just after "("
 * @returns {number} index of the matching ")" or -1
 */
function matchParen(s, i) {
  let depth = 1
  for (; i < s.length; i++) {
    const c = s[i]
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      const m = s.slice(i).match(/^<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n/)
      if (m) {
        const strip = s[i + 2] === '-'
        let j = i + m[0].length
        while (j < s.length) {
          const nl = s.indexOf('\n', j)
          const line = s.slice(j, nl < 0 ? s.length : nl)
          j = nl < 0 ? s.length : nl + 1
          if ((strip ? line.replace(/^\t+/, '') : line).trim() === m[2]) break
        }
        i = j - 1
        continue
      }
    }
    if (c === '\\') {
      i++
      continue
    }
    if (c === "'") {
      const j = s.indexOf("'", i + 1)
      if (j < 0) return -1
      i = j
      continue
    }
    if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === '\\') i++
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}


/** `$(cat <<'EOF' … EOF)` with a quoted delimiter expands nothing: it is literal text. */
const CAT_HEREDOC = /^\s*cat\s*<<-?[ \t]*(['"])([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*\n([\s\S]*?)\n[ \t]*\2[ \t]*\n?\s*$/
/** @param {string} inner */
export function literalHeredoc(inner) {
  const m = inner.match(CAT_HEREDOC)
  return m ? m[3] : null
}

/**
 * @param {string} src
 * @param {number} depth nesting depth (0 = typed directly)
 * @returns {Parsed}
 */
export function parseShell(src, depth = 0) {
  /** @type {SimpleCommand[]} */
  const commands = []
  /** @type {string[]} */
  const substitutions = []
  /** @type {string[]} */
  const ambiguous = []

  /** @type {SimpleCommand} */
  let cur = { words: [], redirects: [], heredoc: null, background: false, depth }
  let word = ''
  let literal = true
  let inWord = false
  /** @type {string | null} */
  let pendingRedirect = null
  /** @type {{ delim: string, strip: boolean, cmd: SimpleCommand }[]} */
  const pendingHeredocs = []

  const endWord = () => {
    if (!inWord) return
    const w = { text: word, literal }
    if (pendingRedirect) {
      cur.redirects.push({ op: pendingRedirect, target: w })
      if (pendingRedirect === '<<' || pendingRedirect === '<<-') pendingHeredocs.push({ delim: word, strip: pendingRedirect === '<<-', cmd: cur })
      pendingRedirect = null
    } else cur.words.push(w)
    word = ''
    literal = true
    inWord = false
  }
  const endCommand = (/** @type {boolean} */ background = false) => {
    endWord()
    if (pendingRedirect) {
      ambiguous.push(`redirect ${pendingRedirect} without a target`)
      pendingRedirect = null
    }
    if (cur.words.length || cur.redirects.length) {
      cur.background = background
      commands.push(cur)
    }
    cur = { words: [], redirects: [], heredoc: null, background: false, depth }
  }

  let i = 0
  while (i < src.length) {
    const c = src[i]

    if (c === '\n') endWord()
    if (c === '\n' && pendingHeredocs.length) {
      endCommand()
      i++
      for (const h of pendingHeredocs.splice(0)) {
        const lines = []
        while (i < src.length) {
          const nl = src.indexOf('\n', i)
          const line = src.slice(i, nl < 0 ? src.length : nl)
          i = nl < 0 ? src.length : nl + 1
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break
          lines.push(line)
        }
        h.cmd.heredoc = lines.join('\n')
      }
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i++
      continue
    }
    if (c === '#' && !inWord) {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2
        continue
      }
      word += src[i + 1] ?? ''
      inWord = true
      i += 2
      continue
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1)
      if (j < 0) {
        ambiguous.push('unterminated single quote')
        word += src.slice(i + 1)
        inWord = true
        break
      }
      word += src.slice(i + 1, j)
      inWord = true
      i = j + 1
      continue
    }
    if (c === '$' && src[i + 1] === "'") {
      const j = src.indexOf("'", i + 2)
      const body = src.slice(i + 2, j < 0 ? src.length : j)
      if (j < 0) ambiguous.push('unterminated $\'…\' quote')
      if (body.includes('\\')) literal = false
      word += body
      inWord = true
      i = j < 0 ? src.length : j + 1
      continue
    }
    if (c === '"') {
      i++
      inWord = true
      let closed = false
      while (i < src.length) {
        const d = src[i]
        if (d === '"') {
          closed = true
          i++
          break
        }
        if (d === '\\' && i + 1 < src.length) {
          word += src[i + 1]
          i += 2
          continue
        }
        if (d === '$' && src[i + 1] === '(') {
          const end = matchParen(src, i + 2)
          if (end < 0) {
            ambiguous.push('unterminated $( inside double quotes')
            i = src.length
            break
          }
          const inner = src.slice(i + 2, end)
          const lit = literalHeredoc(inner)
          if (lit !== null) word += lit
          else {
            substitutions.push(inner)
            literal = false
            word += src.slice(i, end + 1)
          }
          i = end + 1
          continue
        }
        if (d === '`') {
          const end = src.indexOf('`', i + 1)
          if (end < 0) {
            ambiguous.push('unterminated backtick')
            i = src.length
            break
          }
          substitutions.push(src.slice(i + 1, end))
          literal = false
          word += src.slice(i, end + 1)
          i = end + 1
          continue
        }
        if (d === '$') literal = false
        word += d
        i++
      }
      if (!closed) ambiguous.push('unterminated double quote')
      continue
    }
    if ((c === '$' || c === '<' || c === '>') && src[i + 1] === '(') {
      const end = matchParen(src, i + 2)
      if (end < 0) {
        ambiguous.push(`unterminated ${c}(`)
        break
      }
      const inner = src.slice(i + 2, end)
      const lit = c === '$' ? literalHeredoc(inner) : null
      if (lit !== null) word += lit
      else {
        substitutions.push(inner)
        literal = false
        word += src.slice(i, end + 1)
      }
      inWord = true
      i = end + 1
      continue
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1)
      if (end < 0) {
        ambiguous.push('unterminated backtick')
        break
      }
      substitutions.push(src.slice(i + 1, end))
      literal = false
      word += src.slice(i, end + 1)
      inWord = true
      i = end + 1
      continue
    }
    if (c === '$') {
      literal = false
      word += c
      inWord = true
      i++
      continue
    }
    // redirections (optionally preceded by an fd number already in `word`)
    const redir = REDIRECTS.find((r) => src.startsWith(r, i))
    if (redir && !(redir === '<' && src[i + 1] === '(') && !(redir === '>' && src[i + 1] === '(')) {
      if (inWord && /^\d+$/.test(word)) {
        word = ''
        inWord = false
      } else endWord()
      pendingRedirect = redir
      i += redir.length
      if ((redir === '>&' || redir === '<&') && /[\d-]/.test(src[i] ?? '')) {
        while (/[\d-]/.test(src[i] ?? '')) i++
        pendingRedirect = null
      }
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (op) {
      if (op === '\n' || op === ';' || op === ';;' || op === '&&' || op === '||' || op === '|' || op === '|&' || op === '(' || op === ')') endCommand()
      else if (op === '&') endCommand(true)
      i += op.length
      continue
    }
    word += c
    inWord = true
    i++
  }
  endCommand()
  if (pendingHeredocs.length) ambiguous.push('here-document without terminator')
  return { commands, substitutions, ambiguous }
}
