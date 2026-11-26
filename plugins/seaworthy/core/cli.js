// @ts-check
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
/**
 * @typedef {{
 *   stdin: NodeJS.ReadableStream,
 *   stdout: { write(s: string): unknown },
 *   stderr: { write(s: string): unknown },
 *   cwd: string,
 *   env: Record<string, string | undefined>
 * }} IO
 * @typedef {(args: string[], io: IO) => Promise<number>} Command
 */

/** @type {Record<string, { summary: string, load: () => Promise<{ run: Command }> }>} */
export const COMMANDS = {
  init: { summary: 'Detect checks and write .seaworthy.json', load: () => import('./commands/init.js') },
  detect: { summary: 'Print detected project config', load: () => import('./commands/detect.js') },
}

export function usage() {
  const lines = ['Usage: seaworthy <command> [options]', '', 'Commands:']
  for (const [name, c] of Object.entries(COMMANDS)) lines.push(`  ${name.padEnd(18)} ${c.summary}`)
  return lines.join('\n') + '\n'
}

/**
 * @param {string[]} argv
 * @param {IO} io
 * @returns {Promise<number>}
 */
export async function main(argv, io) {
  const [name, ...rest] = argv
  if (!name || name === '--help' || name === '-h' || name === 'help') {
    io.stdout.write(usage())
    return 0
  }
  const entry = COMMANDS[name]
  if (!entry) {
    io.stderr.write(`seaworthy: unknown command "${name}"\n` + usage())
    return 2
  }
  const mod = await entry.load()
  return mod.run(name === 'waive' ? ['--waive', ...rest] : rest, io)
}

/** @returns {IO} */
export function processIO() {
  return { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, cwd: process.cwd(), env: process.env }
}

const isEntry = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
if (isEntry) {
  main(process.argv.slice(2), processIO()).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`seaworthy: ${err instanceof Error ? err.stack || err.message : String(err)}\n`)
      process.exit(1)
    },
  )
}
