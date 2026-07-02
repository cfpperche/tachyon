# 322 — probes-per-agent — plan

_Drafted from `spec.md` on 2026-07-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

View/navigation refactor over an already-adequate data layer (`ProbeRunMeta.caller` is persisted per run since spec 257):

1. **Filter plumbing**: `Workspace.probeView(caller?)` filters `probeStore.list()` rows by `caller` before `buildProbeView`; `ProbeResultPanelManager` keys panels by `wsHash:caller` (falling back to `wsHash:*` for the unfiltered escape hatch) and passes the caller into the panel so the title reads "Probes — <agent>" and re-renders keep the filter.
2. **Row action**: new `"probes"` ActionId — `ACTION_META` icon `search`/label "Probes", pushed in `actionsFor` for `ai` rows (same availability as `activity`: durable records, no live pane required), NOT in `primaryActions` (lands in the "…" more-menu). Dispatch: a special case in `SidebarPrototype.runAction` next to `activity`, calling `tachyon.openProbes` with `(wsHash, agentName)`.
3. **Global surface removal**: delete `ProbesBtn` + its render sites + `GlobalOp "openProbes"` wiring in the sidebar webview; drop `fleet.probes` from `FleetVM` + its producer in `gatherOne`; remove the view-title toolbar button and hide the command from the palette (the command itself stays as the action target + no-arg escape hatch for unattributed probes).
4. **Panel/webview**: `probes/App.tsx` gets the caller in its view model for the title + an honest empty state; rows already carry a caller column (kept — harmless in filtered view, useful in the escape hatch).

## Key decisions

- **Filter at `probeView`, not `ProbeStore.list`** — the store stays a dumb persistence layer; the view builder is where presentation-shaped concerns (already status/count derivation) live. Rejected: a `list(caller)` param — pushes UI filtering into storage for no gain at this scale (≤50 rows scanned).
- **Panel per (workspace, agent), mirroring Activity** — two agents' probes side by side is the natural comparison flow during duets. Rejected: one panel that re-filters — loses side-by-side and diverges from Activity's model.
- **Action availability mirrors `activity` (ai-only, pane-independent, more-menu)** — probes are durable per-agent history exactly like the activity log. Empty state over hiding: a menu item that appears/disappears with data is a discoverability trap.
- **The palette/global list becomes an internal escape hatch, not deleted** — `caller` is optional and agents get dismissed; fully deleting the unfiltered view would orphan those records. The pin's intent ("remove global") is honored at the SURFACES (chip + toolbar + palette visibility), not by making data unreachable.
- **`fleet.probes` dies with the chip** — keeping a dead field invites zombie producers; if a live per-agent running badge is missed, that's a scoped follow-up.

## Files touched

- `src/workspace/Workspace.ts` — `probeView(caller?)`.
- `src/probe/probeView.ts` — optional caller filter + caller in the VM (title/empty-state).
- `src/webview/ProbeResultPanel.ts` — panel keyed `wsHash:caller`, title per agent, caller passed through the READY handshake.
- `src/extension.ts` — `tachyon.openProbes` accepts `(wsHash, agent?)`; refreshAll keeps filters.
- `src/sidebar/actions.ts` — `"probes"` ActionId + META + `actionsFor` (more-menu only) + tests.
- `src/webview/SidebarPrototype.ts` — `runAction` special case; remove `probes:` producer in `gatherOne`.
- `src/webview/sidebar/App.tsx` — remove `ProbesBtn` + render sites; `src/sidebar/types.ts` — remove `fleet.probes` + `GlobalOp "openProbes"`.
- `src/webview/probes/App.tsx` + `messages.ts` — caller-aware title + empty state.
- `package.json` — remove the view-title button; hide the command from the palette.
- Tests: `sidebarActions.test.ts` (new action gating), `probeView` tests (filtering), engine of the panel key if covered.

## Risks & unknowns

- **R1 — `caller` is a free string**: renamed agents orphan old probes into the escape hatch. Accepted (same as activity logs keyed by name).
- **R2 — losing the live "N running" signal**: the chip was the only running-probes indicator; removal is the pin's explicit ask. Follow-up if missed.
- **R3 — package.json palette hiding**: must verify the project's existing pattern for palette-hidden commands (`commandPalette` menu with `when: "false"`) and match it.

## Sources consulted

- Explore-agent research 2026-07-01 (file:line map of ProbeStore/ProbeService/probeView/ProbeResultPanel/ProbesBtn/gatherOne/runAction/ACTION_CMD; spec 257 status SHIPPED, 308/313 shipped, no in-flight probe spec).
- Pin `p-d25af8` + screenshot (current global panel, CALLER column visible).
- `src/sidebar/actions.ts` conventions (spec 237/306 precedents for action gating + tests).

## Design dueto (VIA PROBE — runtime codex, adversarial-review) — folded

Run as `probe-01bdc488` through the probe system itself (the maintainer's instruction, and a fitting dogfood). Verdict: **NEEDS-REVISION**, 7 findings.

- **F1 (major, folded)** — the no-arg escape hatch risked contradicting the pin. Resolution: ALL user-facing contributions go (view-title button, palette visibility); `tachyon.openProbes` stays registered only as the row-action target; its no-arg form is an internal/debug path documented in code, never contributed. Task list gains an explicit contribution audit.
- **F2 (major, folded as accepted regression)** — deleting the chip loses the only live running-probes signal. The pin itself asks for the removal; v1 explicitly accepts the regression (recorded in spec non-goals), the per-agent panel shows running counts once opened, and a per-agent row badge is the named follow-up if missed in practice.
- **F3 (blocker, folded)** — composite panel keying now has a concrete contract: manager map keyed `wsHash\u0000(caller|"*")`; `open(wsHash, caller?)` reveals-or-creates that entry; `refreshAll()` re-posts each entry with ITS OWN filtered view; per-entry dispose; workspace disposal sweeps the `wsHash` prefix. Manual check: two agents' panels open simultaneously with disjoint rows.
- **F4 (major, REBUTTED in part)** — gating the action on persisted-caller existence would make the menu item data-dependent — the discoverability trap the spec explicitly rejects. Row `name` IS the caller namespace (Bridge `caller` = agent name; same convention as activity logs keyed by name). Kept: ai-only + honest empty state. Folded partially: an empty-state VM test.
- **F5 (major, folded in part)** — filtering centralizes in ONE pure function: `buildProbeView(records, now, caller?)` (already the single derivation point for rows+counts); every consumer goes through `Workspace.probeView(caller?)`. Store param rejected: `ProbeStore` stays a dumb persistence layer; one shared pure filter satisfies the finding's centralization goal without widening the storage API.
- **F6 (major, folded)** — exact package.json diff documented in tasks: remove the `view/title` menu entry; add/verify `commandPalette` suppression for `tachyon.openProbes`; no keybindings exist (verified); command contribution kept solely so the title/icon resolve for internal invocation.
- **F7 (minor, folded)** — surface audit added to tasks: ripgrep `openProbes|ProbesBtn|fleet.probes|probes:` across src/ + package.json; verify `searchIndex` (cmd+K) never indexed probes; no status-bar registrations.
