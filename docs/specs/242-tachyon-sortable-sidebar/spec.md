# Spec 242 — sortable sidebar lists (flat + human-chosen order, default A–Z)

**Status:** shipped
**Closure:** Shipped per the implementation closure in `tasks.md` and the completed plan review in `debate.md`; EDH verification remained a recorded follow-up.

## Problem

The **Agents** and **Terminals** sidebar lists are bucketed into status groups (Running / Needs input / Idle /
Stopped / Crashed). Because an agent's status changes constantly (working ↔ idle ↔ needs-input), rows **jump
between groups** — the list reflows under the human's eyes. For someone who isn't actively chasing status, that
movement is noise that loses their place. The status is *already* legible per-row from the colored dot (+ the
existing badges), so the grouping earns churn without adding much.

Today (verified): `App.tsx` buckets `fleet.agents`/`fleet.terminals` by `a.status` into `STATUS_ORDER` groups at
render time (`App.tsx:137-158`); the VM lists are flat (`types.ts`), order is arrival order (no sort); no sidebar
UI state persists (collapse/tab are in-memory only).

## Goal

Replace status-grouping (Agents + Terminals) with a **single flat list** the human **sorts as they like**, default
**alphabetical (A–Z)** — a stable order where a status change only recolors the dot in place (no reflow). A small
**sort selector** in the section header offers:

- **Name (A–Z)** — default (stable; the anti-movement win)
- **Name (Z–A)**
- **Status (live)** — running → needs → idle → stopped → crashed, name as tiebreak (opt-in; labeled *live* because it intentionally reflows on status change)

Status stays legible via the **dot color**, a **dot tooltip + row-level accessible status text**, compact
**per-status count chips** in the header (recovering what the group headers showed), and the existing per-row badges.

## Decisions

- **D1 — flat list, grouping removed for Agents + Terminals only.** Drop the `Group`/status-header wrapper for
  these two tabs; render a flat list of `AgentRow`. Leave the other sections AS-IS: Pipelines & Runbooks group by
  their own entity (pipeline / runbook name — not status, no churn); Commands & Pins are already flat; Schedules'
  "Pending approval" is a deliberate **action** bucket (proposals awaiting you), not status-churn. They are out of
  scope (revisit only if a similar churn complaint lands).
- **D2 — the sort is a PURE, GENERIC function in `src/sidebar/`** — `sortStatusRows(rows, mode, getName, getStatus)`
  (NOT `sortAgents` — Terminals must reuse it), unit-tested in node (the "decision logic in the vscode layer
  escapes CI" lesson, spec 240). `mode = "name-asc" | "name-desc" | "status"`; locale-aware name compare; `status`
  uses the existing `STATUS_ORDER` rank with a name tiebreak; stable. The `Status` mode is surfaced as **`Status
  (live)`** — it intentionally reflows; no hidden "stable-but-status-aware" hybrid (that's grouping renamed).
- **D3 — the sort preference PERSISTS** (it's a deliberate choice; resetting on reload would defeat "always sorted
  how the human wants"). Persist via the host state the EngineHost already exposes (`getState`/`setState`), keyed
  per section (`sidebar.sort.agents`, `sidebar.sort.terminals`). The host includes the saved sort in the fleet/
  prefs message to the webview; the webview dispatches a `setSort` op → host persists + re-sends. Keeps the
  "UI render-only, host owns state" contract (spec 237). Default when unset = `name-asc`.
- **D4 — the selector is an ICON-MENU in the section header** (NOT a cycle button — a cycle too-easily drops you
  into the reflowing `Status (live)` mode). Header layout becomes: title · count · status-chips · *spacer* · sort
  button · ＋New. The sort button (codicon `list-ordered`/`sort-precedence`, accessible name "Sort agents") opens
  the existing webview menu (`MoreBtn`/`openMore` pattern) with the 3 options + a check on the active one.
- **D5 — status legibility WITHOUT groups (codex: dot tooltip alone is not enough).** Keep the colored dot; add a
  dot **tooltip + row-level accessible status text** (screen-reader/keyboard, not hover-only); AND recover the
  per-status COUNT the group headers gave via compact **non-interactive count chips** in the header (e.g. `●1 ●4`,
  each `aria-label="Running: 1"`), non-zero statuses only. Existing badges unchanged.
- **D6 — ship BOTH Agents + Terminals in spec 242** (true twins, one shared code path; shipping only Agents would
  leave the exact inconsistency this refactor removes). Implementation ORDER: Agents first (validate), then
  Terminals (thin reuse of `sortStatusRows` + the header control). "Próximos" = genuinely different panes, future
  specs only if a similar complaint lands.
- **D7 — multi-root sort boundary.** The sidebar shows multiple workspace folders; do NOT intermix folders. Preserve
  folder grouping/order and sort the Agents/Terminals rows **within each root**.
- **D8 — no first-render flicker.** The host includes the saved sort prefs in the INITIAL sidebar VM/message — never
  render arrival/default order and re-sort after async state arrives.
- **D9 — race rule.** `setSort` mutates ONE authoritative host-side prefs object, then republishes the latest fleet
  + prefs; a stale fleet snapshot must never clobber newer prefs.
- **D10 — accessibility.** Keyboard-operable sort menu (open/checked-active/Escape-dismiss/focus-return); per-row
  status available without hover.
- **D11 — flash / auto-scroll by row identity.** The active-agent flash + auto-scroll target row IDs AFTER sort,
  not list indices; a status change under `name-asc` must not retrigger auto-scroll.
- **D12 — existing-user migration.** Unset pref = `name-asc`; no legacy grouping mode is kept. Call the silent
  layout change out in the release notes.

## Non-goals
- Re-sorting Pipelines / Runbooks / Commands / Schedules / Pins (not status-grouped; no churn problem).
- New sort modes beyond name/status in v1 (e.g. "recently active" — needs a per-agent activity timestamp we don't
  surface cheaply yet; deferred).
- Drag-to-reorder / manual custom order (deferred; "custom" is a bigger feature).
- Changing the dot colors, the badges, or the status taxonomy.

## Risks
- **R1 — losing the at-a-glance "what's running" overview** that groups gave. Mitigation: the dot color + the
  `Status` sort option both recover it; default A–Z is the explicit trade for stability. (Confirm in dogfood.)
- **R2 — persistence plumbing is new** (no sidebar UI state persists today). Mitigation: D3 reuses the existing
  host `getState`/`setState`; keep it to a tiny per-section string; pure sort logic is the only CI-tested part.
- **R3 — collapse-state keys for the removed status groups** (`a:running`, `t:idle`, …) become dead. Mitigation:
  drop them with the groups; the folder/pipeline/runbook collapse keys are untouched.

## Acceptance criteria
- [ ] Agents AND Terminals render as ONE flat list each (no status group headers); under `name-asc` a status change recolors the dot **in place** (no reflow).
- [ ] A header icon-menu sort selector offers Name A–Z (default) / Z–A / Status (live), active one checked; switching re-orders immediately; keyboard-operable (open/Escape/focus-return).
- [ ] The chosen sort **persists across webview/window reload**, and the INITIAL render is already in the saved order (no A–Z→saved flicker — D8).
- [ ] Per-status **count chips** in the header recover the lost overview (accessible labels); the dot conveys status with a tooltip + row-level accessible status text (D5/D10).
- [ ] **Multi-root:** folders stay separate/ordered; sort applies within each root (D7).
- [ ] Active-agent flash + auto-scroll target row IDs after sort; no auto-scroll retrigger on a status change under `name-asc` (D11).
- [ ] `sortStatusRows` is pure + unit-tested (each mode + tiebreak + stability), shared by Agents + Terminals.
- [ ] No regression to Pipelines/Runbooks/Commands/Schedules/Pins rendering; release notes call out the silent A–Z default (D12).

## Resolved open questions (see `debate.md`)
- **OQ1** — persist **global per-user, per-section** (`sidebar.sort.agents` / `.terminals`), applied within each folder.
- **OQ2** — flat `STATUS_ORDER` + name tiebreak is enough; no hidden richer ranking.
- **OQ3** — persist from the start (ephemeral undercuts the feature) — D3.
- **OQ4** — icon menu, not a cycle button — D4.
- **OQ5** — losing per-status counts IS a real regression → header count chips — D5.
