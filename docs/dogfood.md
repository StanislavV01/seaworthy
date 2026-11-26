# Dogfooding checklist (v0.1)

Everything below needs a real Claude Code and a real Orca, so it runs on the author's machine.
The automated suite (`npm test`) covers the core, hooks, git hooks, CI logic and the Orca worker
with fakes; these steps check the parts fakes cannot.

## 0. Setup

```bash
cd ~/Desktop/projects/seaworthy && npm install && npm test
cd ~/Desktop/projects/defi-agent
claude --plugin-dir ~/Desktop/projects/seaworthy/plugins/seaworthy
```

## 1. Things only a live Claude Code can confirm

Check each, note the result next to it:

- [ ] `/seaworthy:init` shows the detected checks, and after you confirm `.seaworthy.json` and the
      git hooks exist (`ls .git/hooks/pre-commit .git/seaworthy-core/cli.js`).
- [ ] `/seaworthy:ship small task` starts a session: `node …/core/cli.js state --json` shows your
      Claude Code `session_id`. (Two mechanisms start it: the skill's `!` injection with
      `${CLAUDE_SESSION_ID}`, and the `UserPromptSubmit` hook. Note which one worked: if the state
      shows the session id, at least one does.)
- [ ] Ask Claude to "just commit it now" before checks → the commit is refused with the reasons.
- [ ] Ask Claude to run `sh -c "git commit -am x"` → refused.
- [ ] The reviewer subagent's verdict lands in the state (`review.verdict`). If not, check the
      `agent_type` Claude Code reports for plugin agents (the hook matcher is `^seaworthy:reviewer$`).
- [ ] `seaworthy request-approval <id>` shows **you** a permission prompt (in your permission mode).
- [ ] Stop gate: Claude keeps going while checks are red; after 5 blocks it escalates and stops.
- [ ] Commits have no `Co-Authored-By` (turn off Claude Code commit attribution in settings if the
      gate keeps refusing them).

## 2. Definition-of-done scenarios (from the design)

- [ ] **Happy path:** `/seaworthy:ship add a small, real change` on `defi-agent` → green checks →
      review → commits → push to a feature branch → draft PR (CI there runs on `pull_request`) →
      `seaworthy ci watch` green → `report --final` says shipped.
- [ ] **Test deletion:** ask for a change and then "the test is flaky, just remove it" → guard
      event, commit refused until you approve or the agent restores the test.
- [ ] **Build-only failure:** reintroduce the `wagmi/connectors` barrel import → `check --tier commit`
      may pass, `check --tier push` (build) fails → push refused.

## 3. Orca

```bash
cd /path/to/orca-checkout && pnpm validate:plugin ~/Desktop/projects/seaworthy
orca plugin dev ~/Desktop/projects/seaworthy
```

- [ ] The plugin installs (trusted-worker approval prompt lists workspace:read, agent:read,
      notifications:show, settings:own).
- [ ] Ship Score panel lists local worktrees; seaworthy-enabled ones show checks.
- [ ] Make a worktree red, let an agent finish (or
      `orca plugin dev emit . agent.status.changed --data '{"workspaceId":"<id>","paneKey":"p","state":"done","receivedAt":0}'`)
      → "Done, but red" notification.
- [ ] Status bar shows `ship n/m`.
- [ ] Opt-in settings: with "Attach the seaworthy Claude Code plugin" on, a new Claude agent in Orca
      has the `/seaworthy:*` skills. Note which `workspaceId` form the hooks receive.

## 4. Publish

- [ ] GitHub repo `seaworthy`, push, CI green.
- [ ] Topic `orca-plugin`, tag `v0.1.0` → onorca.dev/plugins lists it after validation.
- [ ] README demo GIF (Ship Score + a refused commit).
