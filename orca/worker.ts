// seaworthy for Orca — worker (trusted-worker profile, runs in Node as the user).
//  • Done-but-red detector: when any agent reports "done", run the worktree's commit checks and
//    notify if they fail.
//  • Ship Score panel data and a status bar item across all worktrees.
//  • Opt-in: attach the seaworthy Claude Code plugin to Claude launches, and gate Claude's
//    git commit / push through the same rules as the Claude Code hooks.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrcaWorkspace } from './logic.ts'
import { createDebouncer, isLocalWorktree, resolveWorkspace, scoreSummary, verdict, withClaudePlugin } from './logic.ts'
import type { ShipRow, StatusJson } from './types.ts'
// The engine is the same code the Claude Code plugin runs.
// @ts-ignore -- plain JS module with JSDoc types
import { runTier } from '../plugins/seaworthy/core/checks.js'
// @ts-ignore
import { statusJson } from '../plugins/seaworthy/core/report.js'
// @ts-ignore
import { load } from '../plugins/seaworthy/core/hooks/context.js'
// @ts-ignore
import { preToolUse } from '../plugins/seaworthy/core/hooks/handlers.js'
// @ts-ignore
import { loadState } from '../plugins/seaworthy/core/state.js'

const PLUGIN_DIR = fileURLToPath(new URL('../plugins/seaworthy', import.meta.url))
const env = process.env as Record<string, string | undefined>

type Orca = any

export default async function activate(orca: Orca) {
  const agentStates = new Map<string, string>()
  const debounce = createDebouncer(10_000)

  const settings = async (): Promise<Record<string, unknown>> => {
    try {
      return (await orca.host.call('settings.get', {})).settings ?? {}
    } catch {
      return {}
    }
  }
  const workspaces = async (): Promise<OrcaWorkspace[]> => (await orca.host.call('workspace.list', { includeStatus: true })).workspaces ?? []
  const tracked = (ws: OrcaWorkspace) => isLocalWorktree(ws) && existsSync(join(ws.path, '.seaworthy.json'))
  const status = async (ws: OrcaWorkspace): Promise<StatusJson | null> => {
    try {
      return await statusJson(ws.path, env)
    } catch (err) {
      orca.log(`status failed for ${ws.path}: ${String(err)}`)
      return null
    }
  }

  async function rows(): Promise<ShipRow[]> {
    const out: ShipRow[] = []
    for (const ws of await workspaces()) {
      if (!isLocalWorktree(ws)) continue
      const st = tracked(ws) ? await status(ws) : null
      out.push({ workspaceId: ws.id, name: ws.name, branch: ws.branch, path: ws.path, agentState: agentStates.get(ws.id) ?? ws.status?.state ?? null, verdict: verdict(st), status: st })
    }
    return out
  }

  async function refreshStatusBar() {
    try {
      const all = (await rows()).map((r) => r.status).filter((s): s is StatusJson => s !== null)
      const s = scoreSummary(all)
      await orca.host.call('statusBar.update', { id: 'ship-score', text: s.text, tone: s.tone, tooltip: s.tooltip, icon: 'check' })
    } catch (err) {
      orca.log(`status bar: ${String(err)}`)
    }
  }

  async function checkWorktree(ws: OrcaWorkspace, reason: string) {
    return debounce(ws.path, async () => {
      orca.log(`running commit checks in ${ws.path} (${reason})`)
      const r = await runTier(ws.path, 'commit')
      if (!r.ok && (await settings()).notifyDoneButRed !== false) {
        await orca.host.call('notifications.show', {
          title: 'Done, but red',
          body: `${ws.branch ?? ws.name}: ${r.failed.join(', ')} failing — the agent said it was done.`,
        })
      }
      orca.panels.post('ship.changed', { workspaceId: ws.id })
      await refreshStatusBar()
      return r
    })
  }

  orca.events.on('agent.status.changed', async (e: any) => {
    const key = e.workspaceListId ?? e.workspaceId
    if (key) agentStates.set(key, e.state)
    if (e.state !== 'done') return
    const ws = resolveWorkspace(await workspaces(), e.workspaceListId, e.workspaceId)
    if (!ws || !tracked(ws)) return
    await checkWorktree(ws, 'agent reported done')
  })

  orca.events.on('workspace.removed', () => refreshStatusBar())

  orca.panels.handle('ship.rows', async () => rows())
  orca.panels.handle('ship.check', async ({ workspaceId }: { workspaceId: string }) => {
    const ws = resolveWorkspace(await workspaces(), workspaceId)
    if (!ws || !tracked(ws)) return { ok: false, failed: ['not a seaworthy worktree'] }
    const r = await runTier(ws.path, 'commit')
    orca.panels.post('ship.changed', { workspaceId })
    await refreshStatusBar()
    return { ok: r.ok, failed: r.failed }
  })

  orca.commands.register('seaworthy.refresh', async () => {
    await refreshStatusBar()
    return 'Ship Score refreshed'
  })
  orca.commands.register('seaworthy.checkFocused', async () => {
    const ctx = await orca.host.call('workspace.readContext', {})
    const ws = resolveWorkspace(await workspaces(), ctx?.workspaceId)
    if (!ws || !tracked(ws)) return 'This workspace does not use seaworthy (run `seaworthy init` in it).'
    const r = await runTier(ws.path, 'commit')
    await refreshStatusBar()
    return r.ok ? `Commit checks green in ${ws.branch ?? ws.name}` : `Commit checks red in ${ws.branch ?? ws.name}: ${r.failed.join(', ')}`
  })

  // Opt-in: give every Claude Code agent Orca launches the seaworthy plugin.
  orca.hooks.on('agent.launch.before', async (event: any, next: any) => {
    if ((await settings()).autoAttachClaudePlugin !== true) return next(event)
    if (!/claude/i.test(String(event.agent))) return next(event)
    const ws = resolveWorkspace(await workspaces(), event.workspaceId)
    if (!ws || !isLocalWorktree(ws)) return next(event)
    return next({ ...event, command: withClaudePlugin(event.command, PLUGIN_DIR) })
  })

  // Opt-in: apply seaworthy's commit/push gate to Claude Code tool calls inside Orca.
  orca.hooks.on('agent.tool.before', async (event: any, next: any) => {
    if (event.tool !== 'Bash' && !['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(event.tool)) return next(event)
    if ((await settings()).gateClaudeCommits !== true) return next(event)
    const ws = resolveWorkspace(await workspaces(), event.workspaceId)
    if (!ws || !tracked(ws)) return next(event)
    let state: any
    try {
      state = await loadState(ws.path, env)
    } catch {
      return { deny: 'seaworthy: session state was tampered with; git writes are frozen until `seaworthy stop`' }
    }
    if (!state) return next(event)
    const ctx = await load({ cwd: ws.path, session_id: state.session_id, tool_name: event.tool, tool_input: event.input }, env)
    if (!ctx) return next(event)
    const res = await preToolUse(ctx)
    const out = res.stdout ? JSON.parse(res.stdout) : null
    if (out?.hookSpecificOutput?.permissionDecision === 'deny') return { deny: out.hookSpecificOutput.permissionDecisionReason }
    return next(event)
  })

  await refreshStatusBar()
  const timer = setInterval(refreshStatusBar, 60_000)
  timer.unref?.()
}

export async function deactivate() {}
