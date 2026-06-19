# 237 — sidebar fleet navigation at scale (native palliative → opt-in hybrid webview) — PLAN v2 (for review)

_Created 2026-06-19. **Revised after codex review (PLAN-NEEDS-CHANGES, 7 MAJOR + 2 MINOR — all folded).**
The native `tachyonTree` doesn't scale in large fleets; v1 over-committed to a costly full webview before
proving cheaper native relief. v2 is phased + evidence-gated + commits to HYBRID, not a tree replacement._

## Problem (validated demand — corrected shape)
The sidebar is ONE unified tree: `createTreeView("tachyonTree", …)` (`extension.ts:530`) backed by
`TachyonProvider`, with category nodes — Bridge, an **Agents** group, a **Terminals** group, lineage nesting
(`Sidebar.ts:374-394`). In a project with many agents the **Agents expansion** becomes an unscrollable wall:
the TreeView API offers **no in-view search/filter, no virtualization control, no rich per-row layout**. Real,
recurring demand across multiple projects — navigation, not aesthetics. (v1 wrongly called the sections an
"accordion of views"; there is a single view.)

## codex review folds (the corrections)
- **MAJOR — don't jump to a full webview.** Cheapest relief first, as a control (codex M1/M2). The native
  `AgentsProvider` already has kind groups (`Sidebar.ts:379-394`) + root filtering (`:374-376`) — adding
  status grouping + a fuzzy QuickPick needs **no** menu/a11y/keybinding/selection loss.
- **MAJOR — the "pure VM from getChildren" claim was false.** Row data is entangled with `vscode.TreeItem`
  construction (`AgentTreeItem` builds contextValue/icons/commands/tooltips/verify badges, `Sidebar.ts:80-207`;
  `getChildren` does async reads + builds TreeItems, `:312-368`). A shared **non-vscode row builder** must be
  EXTRACTED first, then BOTH the tree and any webview render from it.
- **MAJOR — command handlers expect `AgentTreeItem` instances** (`item.ws`/`item.agentName`/`item.contextValue`
  at `extension.ts:929-968`, `:1179-1244`, `:1246-1295`). Webview messages can't pass class instances → a
  typed action adapter ({wsHash, agentName, contextValue} → shared command fn) + tests for destructive actions.
- **MAJOR — "54 actions" overstated.** Total `view/item/context` = 54, but the **agent-row** surface is ~16
  context-menu entries (`package.json:439…`) **plus the primary-row action** (Open Terminal, `Sidebar.ts:133/
  153/201`). Enumerate the matrix FROM `package.json` + the row primary action — **the count is approximate,
  never the contract.** The hard part isn't the count — it's the **capability gating** encoded in
  `agentContextValue` (`contextValue.ts`): `agent-<state>[-ai][-adhoc][-worktree][-verifiable][-forkable]
  [-harness]`. Parity = an explicit action matrix over those parts (guarded like `test/unit/contextValue.test.ts`).
- **MAJOR — `postMessage` reveal is NOT near-parity.** The native tree owns the badge (`extension.ts:414-431`)
  + attention/terminal-open on spawn/restart/resume (`Workspace.ts:285-294`); a webview scroll only works while
  alive. Keep the native tree/badge as the attention anchor.
- **MAJOR — the pure/shell boundary needs a client-state reducer too.** Even `AgentForm.ts:179-238` has real
  control flow (ready/init/submit/errors/dispose); a live virtualized list adds focus, scroll restore,
  debounce/coalescing, stale-message handling, in-flight state, keyboard routing. Test a **pure UI reducer**,
  and enforce "**no Workspace/manager/business imports in `SidebarView`**" (a dependency guard) — NOT the blunt
  "imports no logic", which is theater.
- **MINOR — concrete flag**: add `tachyon.sidebar.experimental` (default false); contribute the webview view
  with `when: config.tachyon.sidebar.experimental`, **side-by-side** with `tachyonTree` (don't hide it).
- **MINOR — a11y bar**: keyboard-only acceptance, roving tabindex / `aria-activedescendant`,
  `aria-setsize`/`aria-posinset` or an explicit virtual-list strategy, `vscode-using-screen-reader` +
  `vscode-reduce-motion` handling — gates "validated".

## Approach — phased + evidence-gated; HYBRID is the intended end state
**Phase 0 — native palliative (FIRST deliverable, the control).** No webview. **(a) ship `Tachyon: Find Agent`
fuzzy QuickPick FIRST** — jump-to-agent with inline `Open Terminal` + `Reveal in Tree`; highest leverage, no
view state. **(b) then optional group-by-status** (running / needs-input / idle / stopped) — but **root-only:
descendants stay nested under their parent** (lineage is preserved by nesting children under parents regardless
of status, `Sidebar.ts:370`; a naive status split would tear parent/child apart and make reveal ambiguous), or
a non-structural status **sort/filter** instead. A `hide stopped/idle` toggle is deferred (adds persistent view
state). Cheap, targeted, zero loss of menus/keybindings/a11y/selection. **Dogfood in a genuinely large fleet
(incl. an acceptance case: parent/child agents with DIFFERENT statuses + QuickPick reveal). If the scroll/
cognition pain is gone → STOP and ship this. No webview.** (codex Q5/Q1.)

**Phase 1 — extract the shared row model + shared command functions (only if Phase 0 is insufficient).**
(a) Pull agent-row data out of `AgentTreeItem`'s constructor into a pure `AgentRowSnapshot` builder (no vscode
imports); render the EXISTING tree from it (behavior-preserving refactor). (b) Refactor the command handlers
off `AgentTreeItem` instances into shared `{ws, agentName, contextValue}` functions — **including the complex
destructive paths (delete/dismiss/worktree-cleanup, `extension.ts:1179`/`:1246`)** — still consumed by the
native tree. Doing this behind the unchanged native tree is the SAFE de-risk: the same commands stay exercised
while the coupling is removed (codex Q2). Unit-test the builder + the action matrix (regex-guard style) + the
destructive functions. **The webview *payload* adapter ({wsHash,agentName,contextValue} from a postMessage) is
Phase 2 only** — Phase 1 ships shared functions, not the webview wiring. Valuable on its own (DRY + testable),
independent of any webview (codex Q3).

**Phase 2 — opt-in HYBRID agents webview (only if Phase 1's evidence still shows the tree can't navigate).**
A SECOND view in the `tachyon` container, `"type": "webview"`, `when: config.tachyon.sidebar.experimental`,
**side-by-side** with the native tree. The webview renders ONLY the agents list (search + group + virtualize);
the **native tree keeps** Bridge, terminals, pins, schedules, lineage, the badge + attention anchor, and the
context-menu-heavy flows. (codex Q3: commit to hybrid; codex Q1: agents are the right hard case, but
read-mostly + open-terminal FIRST, then destructive actions with tests.)

## Architecture (Phase 2 — pure logic, thin shell, enforced)
| layer | file | tested |
|---|---|---|
| **row snapshot (pure, Phase 1)** | `presentation/sidebar/agentRow.ts` — `buildAgentRows(state): AgentRowSnapshot[]`; consumed by BOTH tree + webview | ✅ unit @ 200 agents |
| **action matrix (pure)** | `presentation/sidebar/actionMatrix.ts` — `availableActions(contextValue): ActionId[]` over the `agent-…` parts | ✅ unit (mirror `contextValue.test.ts`) |
| **action adapter (pure)** | `presentation/sidebar/sidebarActions.ts` — `resolveAction({wsHash,agentName,contextValue,id}): SidebarCommand` → the **Phase-1 shared command fns** (this is just the webview *payload* decoder; the fns themselves were de-coupled in Phase 1) | ✅ unit (incl. destructive) |
| **client UI reducer (pure)** | `webview/sidebar/uiReducer.ts` — focus/scroll/filter/in-flight/stale-message | ✅ unit |
| **shell (thin, vscode-bound)** | `webview/SidebarView.ts` — `WebviewViewProvider`: render snapshot+matrix → HTML, `onDidReceiveMessage` → adapter, push on engine change, getState/setState scroll/filter. **Imports no Workspace/manager/business module** (dependency guard). | EDH/manual |

**Reveal/attention (Phase 2):** native tree + badge remain the attention anchor; the webview shows an
attention COUNT and a best-effort scroll-into-view via `{type:'reveal',agent}` (works only while the view is
alive — explicitly documented; the native badge is the durable signal).

## Success criteria
- **Phase 0**: in a real large fleet, find-agent + status-collapse removes the scroll/cognition pain
  (dogfood, not a synthetic count). If met → done.
- **Phase 1**: tree renders from `buildAgentRows`, byte-equivalent behavior; the builder + action matrix are
  unit-tested; no regression.
- **Phase 2**: 100+ agents with search/group/virtualize; the agent actions (enumerated from `package.json` +
  the primary-row action) work via the typed adapter (capability-gated by the matrix; destructive actions
  tested); pure VM/matrix/adapter/reducer all unit-tested; the dependency guard passes; a11y bar met; native
  tree stays default + unaffected; cost/LOC recorded.

## Out of scope
Commands/Pins/Schedules webview tabs; removing the native tree; any engine/Bridge change. Each later + separate.

## Decisions (codex-resolved)
1. **First step** = native palliative (control), NOT a webview. Webview only if palliative + shared-model
   evidence still fails.
2. **reveal()** is not equivalent → acceptable only as an opt-in experiment while the native tree/badge remain;
   a full replacement would be a regression.
3. **Hybrid is the intended end state** — native tree owns everything context-/badge-/reveal-heavy; webview owns
   only the scale-heavy agents list.
4. **Boundary enforcement** = typed protocol + pure VM/matrix/adapter/reducer tests + an action matrix vs
   `agentContextValue` + a dependency guard (no engine/workspace imports in the shell). The grep "no logic"
   guard alone is theater.
5. **Worth-it gate** = Phase 0 must FAIL in a real fleet before paying any webview cost.

## Resolved (codex v2 review)
1. **Phase-0 palliative** → Find-Agent QuickPick is the right cheapest high-leverage move; ship it FIRST (with
   Open Terminal + Reveal in Tree). Group-by-status is fine ONLY with the root-only/lineage-preserving
   constraint above; a `hide stopped/idle` toggle is secondary (persistent view state).
2. **Handler refactor** → do it in Phase 1 behind the still-native tree (the same commands stay exercised while
   the `AgentTreeItem` coupling is removed) — the safer de-risk. Keep it narrow; the destructive paths
   (`extension.ts:1179`/`:1246`) are the delicate part.
3. **Shared row-model extraction** → worth it on its own merits regardless of Phase 2 — today row construction
   mixes async workspace reads, ledger/resume/verify probes, lineage, contextValues, icons, tooltips, commands
   (`Sidebar.ts:58`/`:312`); a pure snapshot builder cuts drift even if the webview never ships.
