// Pure helpers for the Orca extension (no Orca or filesystem access), so they can be unit-tested.
// Written as erasable TypeScript: Orca transpiles it, and Node runs it with type stripping.

import type { StatusJson } from './types.ts'

export interface OrcaWorkspace {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  path: string
  branch: string | null
  hostId: string | null
  status?: { state: string }
}

const WSL_PREFIXES = ['\\\\wsl.localhost\\', '\\\\wsl$\\', '//wsl.localhost/']

/** Finds a workspace by the id an event or hook carries (either id form). */
export function resolveWorkspace(workspaces: OrcaWorkspace[], ...ids: (string | null | undefined)[]): OrcaWorkspace | null {
  for (const id of ids) {
    if (!id) continue
    const ws = workspaces.find((w) => w.id === id)
    if (ws) return ws
  }
  return null
}

/** seaworthy runs where the worker runs: only local, non-WSL git worktrees. */
export function isLocalWorktree(ws: OrcaWorkspace): boolean {
  if (ws.kind !== 'worktree') return false
  if (ws.hostId !== null && ws.hostId !== 'local') return false
  const p = ws.path.toLowerCase()
  return !WSL_PREFIXES.some((prefix) => p.startsWith(prefix))
}

/** Is this worktree ready to merge by seaworthy's standards? */
export function isReady(st: StatusJson): boolean {
  const checksGreen = st.checks.push === 'green' || st.checks.commit === 'green'
  return st.tracked && !st.tampered && checksGreen && st.guard.open === 0 && (!st.session || st.review === 'approve')
}

/** One-word verdict for a row in the Ship Score panel. */
export function verdict(st: StatusJson | null): 'ready' | 'blocked' | 'tampered' | 'running' | 'untracked' {
  if (!st || !st.tracked) return 'untracked'
  if (st.tampered) return 'tampered'
  if (isReady(st)) return 'ready'
  if (st.checks.commit === 'none' && st.checks.push === 'none') return 'running'
  return 'blocked'
}

/** Status bar text, tone and tooltip from all tracked worktrees. */
export function scoreSummary(statuses: StatusJson[]): { text: string; tone: 'neutral' | 'success' | 'warning' | 'danger'; tooltip: string } {
  const tracked = statuses.filter((s) => s.tracked)
  if (tracked.length === 0) return { text: 'seaworthy —', tone: 'neutral', tooltip: 'No worktree uses seaworthy yet (run seaworthy init)' }
  const ready = tracked.filter(isReady).length
  const tampered = tracked.some((s) => s.tampered)
  const guards = tracked.reduce((n, s) => n + s.guard.open, 0)
  return {
    text: `ship ${ready}/${tracked.length}`,
    tone: tampered ? 'danger' : ready === tracked.length ? 'success' : guards > 0 ? 'danger' : 'warning',
    tooltip: `${ready} of ${tracked.length} seaworthy worktrees are ready${guards ? ` · ${guards} guard event(s) open` : ''}${tampered ? ' · tampered state!' : ''}`,
  }
}

/** Adds the seaworthy plugin to a Claude Code launch command, once. */
export function withClaudePlugin(command: string, pluginDir: string): string {
  if (!/(^|[\s/])claude(\s|$)/.test(command)) return command
  if (command.includes('--plugin-dir')) return command
  const quoted = /^[\w./-]+$/.test(pluginDir) ? pluginDir : `'${pluginDir.replace(/'/g, `'\\''`)}'`
  return command.replace(/(^|[\s/])claude(?=\s|$)/, `$1claude --plugin-dir ${quoted}`)
}

/** Runs `fn` for a key at most once per `ms`, and never twice at the same time. */
export function createDebouncer(ms: number, now: () => number = Date.now) {
  const last = new Map<string, number>()
  const running = new Set<string>()
  return async function run<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
    const t = now()
    if (running.has(key) || (last.has(key) && t - (last.get(key) as number) < ms)) return null
    running.add(key)
    last.set(key, t)
    try {
      return await fn()
    } finally {
      running.delete(key)
    }
  }
}
