// Mirrors the shape returned by plugins/seaworthy/core/report.js statusJson().
export interface StatusJson {
  tracked: boolean
  session: boolean
  tampered: string | null
  phase: string | null
  task: string | null
  branch: string | null
  checks: Record<'fast' | 'commit' | 'push', 'green' | 'red' | 'stale' | 'none'>
  failed: string[]
  guard: { open: number; ids: string[] }
  review: 'approve' | 'changes_requested' | 'stale' | 'none'
  ci: { status: string; prUrl: string | null; cycles: number }
  gitHooks: boolean
  escalation: string | null
  updatedAt: string | null
}

export interface ShipRow {
  workspaceId: string
  name: string
  branch: string | null
  path: string
  agentState: string | null
  verdict: 'ready' | 'blocked' | 'tampered' | 'running' | 'untracked'
  status: StatusJson | null
}
