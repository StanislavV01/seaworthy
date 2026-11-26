// @ts-check
import { deny, load, PASS } from '../hooks/context.js'
import { HANDLERS } from '../hooks/handlers.js'

/**
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<string>}
 */
async function readAll(stream) {
  let s = ''
  for await (const chunk of stream) s += chunk
  return s
}

/**
 * `seaworthy hook <name>`: entry point for every Claude Code hook. Reads the hook JSON on stdin
 * and answers per Claude Code's hook protocol. Pass-through when no session is active.
 * PreToolUse fails closed: an internal error during an active session denies the call.
 * @type {import('../cli.js').Command}
 */
export async function run(args, io) {
  const name = args[0] ?? ''
  const handler = HANDLERS[name]
  if (!handler) {
    io.stderr.write(`seaworthy hook: unknown hook "${name}" (${Object.keys(HANDLERS).join(', ')})\n`)
    return 2
  }
  let input = {}
  try {
    const raw = await readAll(io.stdin)
    input = raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return 0
  }
  let result = PASS
  try {
    const ctx = await load(input, io.env)
    if (ctx) result = await handler(ctx)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (name === 'pre-tool-use') {
      try {
        const ctx = await load(input, io.env).catch(() => null)
        if (ctx && (ctx.active || ctx.tampered)) result = deny(`internal error, refusing to be safe: ${msg}`)
      } catch {
        /* no session information: pass */
      }
    }
    io.stderr.write(`seaworthy hook ${name}: ${msg}\n`)
  }
  if (result.stdout) io.stdout.write(result.stdout + '\n')
  if (result.stderr) io.stderr.write(result.stderr + '\n')
  return result.exitCode
}
