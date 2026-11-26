// @ts-check
import { parseArgs, writeJson } from '../args.js'
import { afterCiFailure } from '../caps.js'
import { failureExcerpt, ensurePr, GhUnavailable, rerunFailed, watchRuns } from '../ci.js'
import { DEFAULT_CAPS, loadConfig } from '../config.js'
import { currentBranch, defaultBranch, headSha, topLevel } from '../git.js'
import { loadState, logEvent, saveState } from '../state.js'
import { ciRunsOnPush, hasPullRequestCi, readWorkflows } from '../workflows.js'

/**
 * `seaworthy ci watch` — wait for CI on HEAD (bounded), rerun a first-seen test failure once,
 *   and tell the agent what to do next. Exit: 0 green or no CI, 1 failed (fix it),
 *   3 still running (call again), 4 escalated or paused.
 * `seaworthy ci excerpt` — redacted excerpt of the latest failed run for HEAD.
 * @type {import('../cli.js').Command}
 */
export async function run(args, io) {
  const { flags, positionals } = parseArgs(args)
  const sub = positionals[0]
  const root = await topLevel(io.cwd)
  const cfg = await loadConfig(root)
  const caps = cfg?.caps ?? DEFAULT_CAPS
  const state = await loadState(root, io.env)
  const sha = await headSha(root)
  if (!sha) {
    io.stderr.write('no commits yet\n')
    return 2
  }
  /** @param {object} o @param {string} text */
  const say = (o, text) => (flags.json ? writeJson(io.stdout, o) : io.stdout.write(text + '\n'))

  try {
    if (sub === 'excerpt') {
      const failed = state?.ci.runs.filter((r) => r.sha === sha && r.conclusion !== 'success' && r.conclusion !== 'pending').at(-1)
      if (!failed) {
        say({ excerpt: null }, 'no failed run recorded for HEAD; run `seaworthy ci watch` first')
        return 1
      }
      const ex = await failureExcerpt(root, failed.id, io.env, caps.excerptChars)
      say({ run: failed, excerpt: ex.text, signature: ex.signature }, `Failed run: ${failed.url ?? failed.id}\n\n${ex.text}`)
      return 0
    }
    if (sub !== 'watch') {
      io.stderr.write('usage: seaworthy ci watch|excerpt [--json]\n')
      return 2
    }

    const branch = await currentBranch(root)
    const workflows = await readWorkflows(root)
    if (state) {
      const prev = state.ci.runs.filter((r) => r.sha === state.ci.sha).at(-1)
      if (state.ci.sha && state.ci.sha !== sha && prev && prev.conclusion === 'failure') state.ci.cycles++
      if (state.ci.sha !== sha) state.ci.started_waiting_at = new Date().toISOString()
      state.ci.sha = sha
      state.phase = 'ci'
      if (state.ci.cycles > caps.ciCycles) {
        state.phase = 'escalated'
        state.escalation = `CI still failing after ${caps.ciCycles} fix cycles`
        await saveState(root, io.env, state)
        say({ status: 'escalated', reason: state.escalation }, `seaworthy: escalated — ${state.escalation}. Run \`seaworthy report\`.`)
        return 4
      }
    }

    if (workflows.length === 0) {
      if (state) {
        state.phase = 'report'
        logEvent(state, 'ci', 'no CI configured')
        await saveState(root, io.env, state)
      }
      say({ status: 'none' }, 'no CI configured for this repository (no .github/workflows): nothing to watch')
      return 0
    }
    if (branch && !ciRunsOnPush(workflows, branch) && hasPullRequestCi(workflows)) {
      const pr = await ensurePr(root, branch, await defaultBranch(root), io.env)
      if (state) {
        state.ci.pr_url = pr.url
        logEvent(state, 'pr', `${pr.created ? 'opened draft' : 'found'} ${pr.url}`)
      }
    }
    if (state) await saveState(root, io.env, state)

    let result = await watchRuns(root, sha, io.env, { maxMs: caps.ciWatchSec * 1000, discoveryMs: caps.runDiscoverySec * 1000 })
    /** @param {import('../ci.js').RunsStatus} r */
    const record = async (r) => {
      if (!state) return
      for (const x of r.runs) {
        const conclusion = x.status === 'completed' ? x.conclusion : 'pending'
        const existing = state.ci.runs.find((y) => y.id === x.databaseId)
        if (existing) existing.conclusion = conclusion
        else state.ci.runs.push({ id: x.databaseId, sha, conclusion, url: x.url })
      }
      if (state.ci.runs.length > 100) state.ci.runs.splice(0, state.ci.runs.length - 100)
    }
    await record(result)

    if (result.status === 'failure' && state) {
      const failed = result.runs.find((x) => x.status === 'completed' && !['success', 'skipped', 'neutral'].includes(x.conclusion))
      if (failed) {
        const ex = await failureExcerpt(root, failed.databaseId, io.env, caps.excerptChars)
        const next = afterCiFailure(state, caps, { sha, signature: ex.signature, testOnly: ex.testOnly })
        const rec = state.ci.runs.find((y) => y.id === failed.databaseId)
        if (rec) rec.signature = ex.signature
        logEvent(state, 'ci', `${failed.workflowName} failed → ${next.action}: ${next.reason}`)
        if (next.action === 'rerun' && (await rerunFailed(root, failed.databaseId, io.env))) {
          await saveState(root, io.env, state)
          result = await watchRuns(root, sha, io.env, { maxMs: caps.ciWatchSec * 1000, discoveryMs: 60_000 })
          await record(result)
          if (result.status === 'success') logEvent(state, 'flaky', `${failed.workflowName} passed on rerun: reported as flaky, not fixed`)
        } else if (next.action === 'escalate') {
          state.phase = 'escalated'
          state.escalation = next.reason
          await saveState(root, io.env, state)
          say({ status: 'escalated', reason: next.reason, excerpt: ex.text }, `seaworthy: escalated — ${next.reason}.\n\n${ex.text}`)
          return 4
        }
      }
    }

    if (state) {
      const startedAt = state.ci.started_waiting_at ? Date.parse(state.ci.started_waiting_at) : Date.now()
      state.ci.waited_ms = Date.now() - startedAt
      if (result.status === 'success') state.phase = 'report'
      if (result.status === 'pending' && state.ci.waited_ms > caps.ciTotalWaitMin * 60_000) {
        state.phase = 'waiting_ci'
        logEvent(state, 'ci', `still running after ${caps.ciTotalWaitMin} min: paused`)
      }
      await saveState(root, io.env, state)
    }
    const urls = result.runs.map((x) => `${x.workflowName}: ${x.status === 'completed' ? x.conclusion : x.status} ${x.url}`).join('\n')
    if (result.status === 'success') {
      say({ status: 'success', runs: result.runs }, `CI green for ${sha.slice(0, 7)}\n${urls}`)
      return 0
    }
    if (result.status === 'none') {
      say({ status: 'none' }, `no CI run appeared for ${sha.slice(0, 7)} within ${caps.runDiscoverySec}s (was the branch pushed? does a workflow trigger on it?)`)
      return 3
    }
    if (result.status === 'pending') {
      const paused = state?.phase === 'waiting_ci'
      say({ status: paused ? 'paused' : 'pending', runs: result.runs }, paused ? `CI still running after ${caps.ciTotalWaitMin} min; the session is paused. The developer can resume it with /seaworthy:ship.\n${urls}` : `CI still running; run \`seaworthy ci watch\` again.\n${urls}`)
      return paused ? 4 : 3
    }
    say({ status: 'failure', runs: result.runs }, `CI failed for ${sha.slice(0, 7)}: run \`seaworthy ci excerpt\`, fix locally, re-run checks, commit and push.\n${urls}`)
    return 1
  } catch (err) {
    if (err instanceof GhUnavailable) {
      if (state) {
        logEvent(state, 'ci', err.message)
        await saveState(root, io.env, state)
      }
      say({ status: 'unavailable', reason: err.message }, `seaworthy: cannot watch CI — ${err.message}. Report this to the developer.`)
      return 4
    }
    throw err
  }
}
