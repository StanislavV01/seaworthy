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
  check: { summary: 'Run checks for a tier and record the result', load: () => import('./commands/check.js') },
  guard: { summary: 'Scan session changes for test tampering', load: () => import('./commands/guard.js') },
  claim: { summary: 'Start or resume a session (run by /seaworthy:ship itself)', load: () => import('./commands/claim.js') },
  ci: { summary: 'Watch CI for HEAD / show the failure excerpt', load: () => import('./commands/ci.js') },
  githook: { summary: 'Git hook entry point (backstop)', load: () => import('./commands/githook.js') },
  hook: { summary: 'Claude Code hook entry point', load: () => import('./commands/hook.js') },
  status: { summary: 'Show session status (--json, --line)', load: () => import('./commands/status.js') },
  report: { summary: 'Render the session report (--final marks it done if all green)', load: () => import('./commands/report.js') },
  state: { summary: 'Print raw session state', load: () => import('./commands/state.js') },
  stop: { summary: 'End the session (developer only)', load: () => import('./commands/stop.js') },
  approve: { summary: 'Approve a guard event (developer only)', load: () => import('./commands/approve.js') },
  waive: { summary: 'Waive a review finding (developer only)', load: () => import('./commands/approve.js') },
  'request-approval': { summary: 'Ask the developer to approve a guard event or finding', load: () => import('./commands/request-approval.js') },
  'allow-force-push': { summary: 'Allow one --force-with-lease push (developer only)', load: () => import('./commands/allow-force-push.js') },
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
