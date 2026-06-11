# 203 — tachyon-split-panels

_Created 2026-06-10._

**Status:** shipped

**Update 2026-06-10:** the layouts/split subsystem was **hidden behind `FEATURES.layouts`** (product call — VSCode's native panels cover splitting). Code, config parsing, and layoutLogic unit tests are retained; the Layouts view, Apply/Save Layout commands, and `settings.layout` auto-apply are not surfaced or honored. Flip the flag to re-enable.

**Closure:** 2026-06-10 — unit 188/188 (layouts 13 new), xvfb integration 23 passing incl. sized-apply + capture round-trip + settings.layout auto-arrange scenarios; residual: none

**UI impact:** render
<!-- Editor-grid behavior exercised live in the xvfb host (tabGroups/getEditorLayout asserts); visual feel in the dogfood. -->

## Intent

F22 (user request from F15-F21 dogfood): the layout engine had 3 fixed equal-split
column shapes, applying a layout over stopped agents produced dead tabs, and the
arrangement a user built by hand could not be kept. Research confirmed the VSCode
API supports everything needed: `setEditorLayout` takes PROPORTIONAL sizes (sum=1
per level, recursive nesting — confirmed in the vscode source), and
`vscode.getEditorLayout` returns the live arrangement in the same format,
enabling capture→save→re-apply.

## Acceptance criteria

- [x] **Scenario: richer vocabulary with proportions**
  - **Given** `grid: main-left` + `sizes: [0.7, 0.3]` in a layout
  - **When** applied
  - **Then** the editor splits 70/30 with the right column stacked; presets now: 2up, 3up, 2x2, rows-2, rows-3, main-left, main-right; sizes validated (count per preset, sum≈1, each >0.04)

- [x] **Scenario: save the hand-built arrangement**
  - **Given** agents arranged/resized manually
  - **When** "Save Current Layout As…" (💾 on the Layouts view) runs
  - **Then** the normalized tree (pixel sizes → 2-decimal proportions) + the agents per group land as a `layout:` entry in tachyon.yml via the comment-preserving editor; overwrite asks; zero agent panes refuses

- [x] **Scenario: robust apply**
  - **Given** a layout referencing stopped agents
  - **When** applied
  - **Then** declared agents auto-spawn before their pane opens (no dead tabs), the first agent gets focus, re-applying a matching grid skips setEditorLayout (idempotent, no flicker), and no tab is ever closed

- [x] **Scenario: default layout on start**
  - **Given** `settings.layout: <name>` (validated against layouts:)
  - **When** the workspace activates (or Tachyon: Start runs)
  - **Then** the layout is applied automatically — the workspace opens arranged

- [x] Custom `layout:` trees validate recursively (orientation 0|1, all-or-none sibling sizes, sum≈1); `grid`/`layout` mutually exclusive; capacity derives from leaf count
- [x] No Bridge/tool change — 0.4.3 patch

## Non-goals

- Layout CRUD in the Agent Studio (the 💾 capture + hand-editing cover creation; revisit on demand).
- Preserving exact seats for file-only groups in captures — agents pack into leaves in order on re-apply; files are never closed, they share groups.
