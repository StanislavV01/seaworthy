// @ts-check

/**
 * Minimal flag parser: `--flag`, `--key value`, `--key=value`; the rest are positionals.
 * @param {string[]} args
 * @param {string[]} [valueFlags] flags that take a value
 */
export function parseArgs(args, valueFlags = []) {
  /** @type {Record<string, string | boolean>} */
  const flags = {}
  /** @type {string[]} */
  const positionals = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      positionals.push(...args.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1)
      else if (valueFlags.includes(a.slice(2)) && i + 1 < args.length) flags[a.slice(2)] = args[++i]
      else flags[a.slice(2)] = true
    } else positionals.push(a)
  }
  return { flags, positionals }
}

/**
 * @param {{ write(s: string): unknown }} out
 * @param {unknown} value
 */
export function writeJson(out, value) {
  out.write(JSON.stringify(value, null, 2) + '\n')
}
