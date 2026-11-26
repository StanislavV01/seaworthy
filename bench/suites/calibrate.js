// @ts-check
/**
 * Suite 0 — calibration. Keeps the benchmark itself honest before anything is measured:
 *  - every task starts red (the oracle fails on the starting commit),
 *  - every honest fix passes the oracle,
 *  - every cheat and sloppy attempt makes the VISIBLE tests pass (so it would fool a naive gate)
 *    and fails the hidden oracle (so it really is bad) — except lint-suppress, which the
 *    oracle's strict lint catches.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSandbox, destroy, oracle, run, writeFiles } from '../lib/sandbox.js'
import { TASKS } from '../lib/tasks.js'

/** @param {import('../lib/sandbox.js').Sandbox} sb @param {import('../lib/tasks.js').Edit[]} edits */
function apply(sb, edits) {
  for (const e of edits) {
    if (e.t === 'write') writeFiles(sb.dir, { [e.path]: e.content })
    else {
      const p = join(sb.dir, e.path)
      const c = readFileSync(p, 'utf8')
      if (!c.includes(e.from)) throw new Error(`${e.path}: "${e.from}" not found`)
      writeFileSync(p, c.replace(e.from, e.to))
    }
  }
}

export function calibrate() {
  const rows = []
  for (const t of TASKS) {
    const variants = [['fix', t.fix, 'fix'], ...(t.sloppy ? [[t.sloppy.name, t.sloppy.edits, 'sloppy']] : []), ...Object.entries(t.cheats).map(([n, e]) => [n, e, 'cheat'])]
    for (const [name, edits, kind] of /** @type {[string, any, string][]} */ (variants)) {
      const sb = createSandbox(t, 'none')
      const startRed = !oracle(sb, 'HEAD').ok
      apply(sb, edits)
      const visible = run(sb.dir, ['sh', '-c', 'npm test --silent'], sb.env).code === 0
      sb.git(['add', '-A'])
      sb.git(['commit', '-q', '-m', 'x'])
      const o = oracle(sb, 'HEAD')
      const expectOk = kind === 'fix'
      const pass = startRed && visible && o.ok === expectOk
      rows.push({ task: t.id, variant: name, kind, startRed, visiblePass: visible, oracle: o, pass })
      destroy(sb)
    }
  }
  return rows
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rows = calibrate()
  process.stdout.write(JSON.stringify(rows, null, 2))
  if (rows.some((r) => !r.pass)) process.exitCode = 1
}
