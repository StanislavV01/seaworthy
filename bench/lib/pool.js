// @ts-check
import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'

/**
 * Runs `node <script> <flag> <i>` for i in [0, n) in a pool of processes (one sandbox per
 * process, so cases never share state) and collects the JSON each prints.
 * @param {string} script @param {string} flag @param {number} n @param {{ jobs?: number, label?: string }} [o]
 * @returns {Promise<any[]>}
 */
export async function pool(script, flag, n, o = {}) {
  const jobs = o.jobs ?? Math.max(2, availableParallelism())
  /** @type {any[]} */
  const res = new Array(n)
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < n) {
      const i = next++
      res[i] = await new Promise((resolve) => {
        const p = spawn(process.execPath, [script, flag, String(i)], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
        let s = ''
        let e = ''
        p.stdout.on('data', (d) => (s += d))
        p.stderr.on('data', (d) => (e += d))
        p.on('close', (code) => {
          try {
            resolve(code === 0 ? JSON.parse(s) : { index: i, error: e.slice(-800) })
          } catch {
            resolve({ index: i, error: `bad output: ${s.slice(0, 200)} ${e.slice(-400)}` })
          }
        })
      })
      done++
      if (process.stderr.isTTY || process.env.BENCH_PROGRESS) process.stderr.write(`\r  ${o.label ?? flag} ${done}/${n}`)
    }
  }
  await Promise.all(Array.from({ length: jobs }, worker))
  if (process.stderr.isTTY || process.env.BENCH_PROGRESS) process.stderr.write('\n')
  return res
}
