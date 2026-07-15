# 384 — agent-live-branch-badge — plan

_Drafted from agreed product definition (task t-c64647) on 2026-07-14._

## Approach

Extend the existing sidebar fleet gather path (`SidebarPrototype`) to resolve **live HEAD branch name** per agent from that agent's **session cwd** (ledger `cwd` / worktree path / workspace root fallback), project it on `AgentVM`, and render it as the **first** badge. Keep the existing `worktree` field as the **isolation/config branch** so worktree actions stay correctly gated.

## Key decisions

1. **Source of truth = live HEAD in session cwd** — `git rev-parse --abbrev-ref HEAD` (via WorktreeManager). Not workspace root; not spawn config alone.
2. **Additive VM fields** — `liveBranch?`, `branchDrift?`, `worktreePath?` (tooltip). Keep `worktree?` = ledger/config branch when isolated (actions + drift baseline).
3. **Badge order** — branch badge is always first in `AgentBadges` (maintainer lock). Other badges follow current order after it.
4. **Shared cwd** — still show live branch (quiet class); do not set `worktree` from shared HEAD (would wrongly enable Review/PR/Remove).
5. **Drift** — `branchDrift = !!worktree && liveBranch && liveBranch !== worktree`. Warn badge + tooltip.
6. **Refresh** — resolve during existing async fleet gather (`Promise.all`), same cadence as verify/evidence. No status bar. No separate watcher in v1 (self-heals on next refresh; attention/activity already re-pushes).
7. **Detached HEAD** — omit `liveBranch` (or show short SHA later — omit in v1).
8. **Rejected: status bar / identity line in v1** — scope control; prototype C/D deferred.
9. **Rejected: overloading `worktree` string with live HEAD** — would break action gating and PR flows that treat truthy `worktree` as isolation.

## Files touched

- `src/worktree/WorktreeManager.ts` — `currentBranch(cwd)` helper (best-effort)
- `src/sidebar/types.ts` — `AgentVM` fields
- `src/sidebar/agentModel.ts` — `AgentExtras` + `toAgentVM` mapping
- `src/webview/SidebarPrototype.ts` — gather live branch per agent cwd
- `src/webview/sidebar/App.tsx` — first badge = live branch; remove mid-list config-only badge display (isolation still via `worktree` for actions)
- `src/webview/sidebar/*.css` or `sidebar.css` — quiet/warn styles for branch badge if needed
- `test/unit/agentModel.test.ts` (+ gather/unit coverage as fits)
- SAMPLE in types if useful for preview

## Risks

- **N × git spawn** on fleet refresh — mitigate with parallel `Promise.all` and best-effort empty on failure; cache later if needed
- **Missing ledger cwd** for never-ran declared agents — fall back to workspace root for shared; omit if not a git repo
- **Detached HEAD / missing worktree path** — omit badge rather than lie

## Visual surface

Sidebar agent rows only. Visual QA via unit/order assertions + manual dogfood on real fleet (or webview preview fixture).

## Sources consulted

- Maintainer lock: live HEAD badge, first in list, no status bar v1 (conversation 2026-07-14)
- `src/webview/SidebarPrototype.ts` L391 — today `worktrees` map = ledger branch only
- `src/webview/sidebar/App.tsx` `AgentBadges` — worktree badge mid-list
- `src/sidebar/actions.ts` — actions gated on `a.worktree`
- `src/worktree/WorktreeManager.ts` — `headState`, `currentBranch` git args
- Specs 210, 331 (non-goal branch chrome), 378 (live projection pattern)
