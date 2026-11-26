// @ts-check

/** @type {[RegExp, string | ((m: string, ...g: string[]) => string)][]} */
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED github token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED github token]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED aws key]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED api key]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED slack token]'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '[REDACTED npm token]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED jwt]'],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, (_m, kind) => `${kind} [REDACTED]`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, '$1[REDACTED]@'],
  [
    /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|private[_-]?key|access[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"']{6,})\3/gi,
    (_m, k, sep, q) => `${k}${sep}${q}[REDACTED]${q}`,
  ],
]

/** Long, mixed-class, high-entropy strings that look like credentials. @param {string} s */
function looksSecret(s) {
  if (s.length < 32 || /^[0-9a-f]+$/i.test(s) && s.length <= 64) return false
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(s)).length
  if (classes < 3) return false
  const counts = new Map()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length)
  return h > 4.2
}

/**
 * Removes credentials from text before it is shown to the model or written to a report.
 * GitHub masks registered secrets in logs, but not everything (structured values, tokens printed
 * by tools), so excerpts get their own pass.
 * @param {string} text
 */
export function redact(text) {
  let out = text
  for (const [re, rep] of RULES) out = out.replace(re, /** @type {any} */ (rep))
  return out.replace(/[A-Za-z0-9+/_=-]{32,}/g, (m) => (looksSecret(m) ? '[REDACTED high-entropy string]' : m))
}
