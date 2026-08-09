# 384 — agent-live-branch-badge

_Created 2026-07-14._

**Status:** shipped

**Task:** `t-c64647`
**Branch / worktree:** `grok/t-c64647-agent-live-branch` @ `/home/goat/tachyon-worktrees/t-c64647-agent-live-branch`

**Closure:** Shipped 2026-07-14 on branch `grok/t-c64647-agent-live-branch` (maintainer-approved). Live HEAD badge first on every agent row; isolated green `--ds-ok` chip; shared quiet; drift via `⚠` + tooltip (chip stays green); agent-block vertical rhythm. Evidence: unit/dogfood tests, headless EDH S1, human EDH dogfood, preview screenshots under `evidence/`.

**Verify:** `npx vitest run test/unit/agentModel.test.ts test/unit/sidebarPrototype.test.ts`
**Verify:** `npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`
**Dogfood:** `npx vitest run test/unit/agentLiveBranch.dogfood.test.ts`
**Dogfood:** `npm run build && npm run dogfood -- dev-host -- headless`

## Intent

With several agents working in parallel (isolated worktrees or shared cwd), the human cannot tell **which git branch each agent is on** without opening a terminal. The VS Code status bar shows the **workspace root** branch (`main*`), not the agent session cwd. Today the sidebar only shows `⎇ <branch>` when a worktree record exists, and that value is the **spawn/config branch** from the ledger — not live `HEAD`.

**Done** = every agent row shows a **live** branch badge (`⎇ <HEAD>`) read from that agent's session cwd, always as the **first** badge in the meta list, updating as HEAD moves (checkout). Worktree path is available in the tooltip when isolated. Drift (live HEAD ≠ config/worktree branch) is visible. VS Code status bar and folder identity line are unchanged (v1).

## Acceptance criteria

- [x] **Scenario: worktree agent shows live HEAD**
  - **Given** an agent with a worktree record whose ledger branch is `tachyon/foo` and the worktree HEAD is still `tachyon/foo`
  - **When** the sidebar gathers the fleet
  - **Then** the row's first badge is `⎇ tachyon/foo` (live HEAD)
- [x] **Scenario: checkout updates the badge**
  - **Given** a worktree agent whose HEAD was `tachyon/foo`
  - **When** HEAD in that worktree moves to `feat/x` and the sidebar refreshes
  - **Then** the first badge reads `⎇ feat/x` (not the stale config branch alone)
- [x] **Scenario: drift is visible**
  - **Given** a worktree agent with config/ledger branch `tachyon/foo` and live HEAD `feat/x`
  - **When** the row renders
  - **Then** the branch badge keeps the green isolated chip and indicates drift with `⚠` + tooltip (not color alone; chip does not go full-warn yellow)
- [x] **Scenario: shared-cwd agent still shows branch**
  - **Given** an agent without worktree isolation whose session cwd is the workspace root on `main`
  - **When** the sidebar gathers the fleet
  - **Then** the first badge is `⎇ main` (quiet tone; does **not** enable worktree-only actions)
- [x] **Scenario: badge order is fixed**
  - **Given** an agent with live branch and any other badges (`working`, `continuity stale`, …)
  - **When** the row meta renders
  - **Then** the branch badge is the **first** badge in the list
- [x] **Scenario: sub-agent inherits cwd (same live branch)**
  - **Given** a child agent whose session cwd is the parent's worktree
  - **When** the fleet is gathered
  - **Then** the child shows the same live HEAD as that cwd (no separate false branch)
- [x] **Scenario: worktree actions still gated by isolation**
  - **Given** a shared-cwd agent showing `⎇ main`
  - **When** row actions are computed
  - **Then** Review worktree / Create PR / Remove worktree are **not** offered (only true worktree records)
- [x] Tooltip on the branch badge includes the session cwd (and config branch when drift)
- [x] VS Code status bar and sidebar folder identity line are **not** changed in this spec

## Non-goals

- VS Code status bar reflecting the focused agent
- Branch chip on the folder identity line (spec 331 follow-up remains open)
- Activity view as primary surface for branch
- Auto-creating worktrees or changing spawn isolation defaults
- Showing full `git status` / dirty file lists on the badge (dirty may exist elsewhere)
- Watching every worktree with inotify as a hard requirement (poll-on-fleet-refresh is enough for v1)

## Open questions

None — product decisions locked with maintainer 2026-07-14 (prototype + written definition + badge-first order). Maintainer approved land 2026-07-14.
