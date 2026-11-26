// @ts-check
/**
 * seaworthy-bench: runs the offline suites and writes bench/RESULTS.md.
 *
 *   node bench/run.js                 calibration + trajectories + fuzzer (~5–15 min, no API cost)
 *   node bench/run.js calibrate       one suite: calibrate | trajectories | fuzz
 *   node bench/live/run.js --n 3      live A/B with Claude Code (costs tokens; see bench/README.md)
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { calibrate } from './suites/calibrate.js'
import { runAll as fuzz } from './suites/fuzz.js'
import { runAll as trajectories } from './suites/trajectories.js'
import { ROOT } from './lib/sandbox.js'

const DIR = join(ROOT, 'bench', 'results')
mkdirSync(DIR, { recursive: true })
const only = process.argv[2]
process.env.BENCH_PROGRESS = '1'
const save = (/** @type {string} */ f, /** @type {any} */ v) => writeFileSync(join(DIR, f), JSON.stringify(v, null, 2) + '\n')

if (!only || only === 'calibrate') {
  process.stderr.write('calibration…\n')
  const rows = calibrate()
  save('calibration.json', rows)
  const bad = rows.filter((r) => !r.pass)
  if (bad.length) {
    process.stderr.write(`calibration FAILED — the benchmark itself is wrong:\n${JSON.stringify(bad, null, 2)}\n`)
    process.exit(1)
  }
}
if (!only || only === 'trajectories') save('trajectories.json', await trajectories())
if (!only || only === 'fuzz') save('fuzz.json', await fuzz())
spawnSync(process.execPath, [join(ROOT, 'bench', 'report.js')], { stdio: ['ignore', 'ignore', 'inherit'] })
process.stderr.write('wrote bench/RESULTS.md\n')
