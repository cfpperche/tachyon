# 304 — sidebar-adhoc-parent-grouping

_Created 2026-06-30._

**Status:** shipped

**Closure:** Shipped 2026-06-30. Added `groupByParent()` (`src/sidebar/sortRows.ts`) composed after the existing `sortRows()` in the sidebar Agents branch (`src/webview/sidebar/App.tsx`) so a spawned agent's row now sorts immediately after its parent, with a cycle-safe cleanup pass (codex design dueto SHIP-WITH-CHANGES, both required findings folded pre-implementation). Validation: 7 new `groupByParent` unit tests + full unit suite (140 files / 1877 tests) green, `tsc` main + webview clean, `/sdd verify` passed (logged in `notes.md`). Human dogfood done 2026-06-30 on packaged `tachyon-0.54.5.vsix`: an ad-hoc AI-CLI child agent's row rendered grouped under its parent even against the active Z→A sort order (log in `notes.md`).

## Intent

_Origin: pin `p-b0755f`, reported with a screenshot — "o agente adhoc nao deveria aparecer como filho do agente que invoca?"_

The sidebar Agents list renders an ad-hoc child agent with a `↳` indent glyph and a "spawned by `<parent>`" badge (`src/webview/sidebar/App.tsx`, `.row.child` in `sidebar.css`) — both signal that the row is a *child* of the agent that spawned it. But the list (`Panel` in `App.tsx:223`, via `sortRows`/`src/sidebar/sortRows.ts`) is sorted **purely alphabetically by name**, with no awareness of the `parent` field. So a child can land anywhere in the list relative to its parent — in the reported case, the child (`taxonomy-review`) sorted to the top while its parent (`codex`) sat several rows below. The visual nesting cue is real but disconnected from the actual list position, which reads as a bug: a child row floating away from its parent looks broken, not nested.

"Done" means an ad-hoc agent's row appears grouped with (immediately after) the agent that spawned it, so the existing `↳`/"spawned by" cues match what the eye sees in the list order — without reintroducing the collapsible/status-grouped sections that spec 242 deliberately flattened away.

## Acceptance criteria

- [x] **Scenario: A spawned child agent sorts adjacent to its parent**
  - **Given** an agent list containing a parent agent and one or more agents with `parent` set to that agent's name
  - **When** the list is sorted (either sort direction)
  - **Then** each child row appears immediately after its parent row, ahead of unrelated agents that would otherwise sort between them alphabetically
- [x] **Scenario: Sort direction still controls ordering within and across groups**
  - **Given** name-asc vs. name-desc sort mode
  - **When** the list is sorted
  - **Then** top-level agents (and sibling groups) still reorder per the chosen direction, and children within a group keep a stable, direction-consistent order
- [x] **Scenario: A child whose parent is absent from the list degrades gracefully**
  - **Given** an agent row whose `parent` does not match any other row currently in the list (parent already exited/removed)
  - **When** the list is sorted
  - **Then** the orphaned child still renders (sorted alphabetically among top-level rows, same as before) — no crash, no dropped row
- [x] **Scenario: A lineage cycle never drops a row or hangs the UI (defensive only — not expected in practice)**
  - **Given** a malformed/transient set of rows whose `parent` references form a cycle (no row in the cycle has a missing-or-absent parent to anchor a top-level pass)
  - **When** the list is sorted
  - **Then** every row in the cycle still renders exactly once (no infinite loop, no dropped row), even though its relative position within the cycle is unspecified
- [x] The existing `↳` indent glyph and "spawned by `<parent>`" badge are unchanged (this spec fixes ordering only, not the visual treatment).
- [x] `sortRows` (`src/sidebar/sortRows.ts`) keeps its generic, name-only, pure-function contract usable by both the Agents and Terminals lists; parent-grouping is additive, not a rewrite of its sort key.
- [x] No collapsible group headers, status-based sections, or new top-level grouping UI are introduced (spec 242 stays in force: the list is flat, status is carried by the per-row dot + header count-chips only).

## Non-goals

- Multi-level nesting (grandchildren, chains of ad-hoc-spawning-ad-hoc) — only one level of parent→child grouping is an acceptance promise, matching what `AgentVM.parent` already models today. The implementation may handle deeper chains defensively (so it doesn't misbehave if one shows up), but that behavior is not a tested contract this spec is on the hook for.
- Reordering the Terminals or Pipelines lists, or any list without a `parent` concept.
- Changing how `parent` is recorded at spawn time (`AgentManager`, `spawn_agent`'s `parent` argument) — this spec only changes how an already-known `parent` affects sidebar ordering.
- Reintroducing the pre-spec-242 status-grouped/collapsible sidebar sections.

## Open questions

- None — see `plan.md` for the codex design dueto that resolved the implementation approach.
