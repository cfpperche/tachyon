# 331 — sidebar-workspace-identity-line — plan

_Drafted from `spec.md` on 2026-07-02. The approach, not the steps (those go in `tasks.md`)._

## Approach

`App.tsx` already renders a per-folder `.grp.folder` header with the `HandoffBtn` chip for the multi-root
path (`fleets.length > 1`). The single-root path (`!multi`) skipped that header entirely and instead
rendered a lone `.handoff-bar` above the section list, holding just the chip.

Collapse that into one path: always map over `fleets` and render the `.grp.folder` header + collapsible
body, regardless of count. Delete the `!multi` ternary and the orphaned `.handoff-bar` block. The host
side already sets `FleetVM.folder` unconditionally for every workspace (`SidebarPrototype.ts` `gatherOne`,
called for every root with no count-based branch) — so no host-side change is needed, only the webview
render path.

Alongside, tidy `HandoffBtn`: rename the "distill" label to "handoff", and collapse its two-span markup
(`aria-hidden` glyph + separate badge) into a single badge span so quiet mode can drop the label text
without a dangling decorative glyph next to an empty badge.

## Key decisions

- **Unify single-root and multi-root into one render path** (remove the `!multi` branch around the folder
  header) — chosen because the pin's decided fix is explicitly "kill the special case, don't relocate the
  chip again"; a single-root workspace becomes a "multi-root with N=1" for rendering purposes. Rejected:
  keeping two branches with the chip moved into a new single-root-only header — that would just create a
  second special case instead of removing one.
- **No host-side change** — `FleetVM.folder` is already populated for every workspace regardless of root
  count (verified in `SidebarPrototype.ts::gatherOne`, called unconditionally per workspace). Only the
  webview's render gate needed to change.
- **Quiet chip = single badge span, glyph-only text when fresh + 0 pending** — chosen to match the pin's
  explicit refinement ("QUIETO quando fresh+0 notas — só o glifo ◆") and the mock's visual contract
  (`/tmp/mission-control/sidebar.html`, which shows one glyph, no wrapping decorative span, in the quiet
  state). Consolidating to one span also removes a pre-existing double-glyph rendering (outer aria-hidden
  ◆ + badge glyph) that the "hoje" mock variant calls out.
- **Tone mapping unchanged** (`warn` for needs_distill/possibly_stale, `err` for old, none for fresh) —
  already matches the pin's "quieto/fresh, âmbar/needs_distill, forte/old" requirement; only the label text
  and quiet-mode gating needed to change.
- **`SAMPLE` fixture gets a `folder` + `handoff`** (`src/sidebar/types.ts`) — chosen so the dev-preview
  harness and default `App` render match production (which always has `folder` set) instead of showing a
  blank/unnamed header; kept to the existing neutral `demohash`/`Demo` fixture convention. Rejected: leaving
  `SAMPLE` folder-less — would silently regress the preview harness's visual fidelity for the identity line
  this spec adds.

## Files touched

- `src/webview/sidebar/App.tsx` — `HandoffBtn` (rename label, single-span quiet mode), remove the
  `.handoff-bar` block, collapse the `!multi ? renderFolder(...) : fleets.map(...)` ternary into one
  unconditional `fleets.map(...)`.
- `src/webview/sidebar/sidebar.css` — remove `.handoff-bar` rule and its mentions in the `flex: 0 0 auto`
  selector list and the `span[aria-hidden]` rule (dead after the single-span consolidation); update stale
  comments referencing the old single-root/multi-root split.
- `src/sidebar/types.ts` — add `folder` + `handoff` to `SAMPLE` for preview fidelity.

## Risks & unknowns

- **Preview/test fixtures without `folder` set** (`scripts/webview-preview/fixtures/sidebar.ts`'s `empty`/
  `evidence-badge`/`error` fixtures spread `base`, which has no `folder`) — these will now render a folder
  header with an empty name instead of none. Accepted: this mirrors what would actually happen if a real
  `Workspace` somehow had no name, and none of these fixtures assert on header absence.
- **Pre-existing, unrelated test failure**: `test/unit/auth.test.ts` expects `listTools().length` to be 29;
  concurrent spec-325 work (out of scope, `src/bridge/tools.ts` explicitly off-limits for this spec) added
  a tool, so it's 30 on `main` before and after this change. Verified by stashing this spec's diff and
  re-running — failure reproduces identically. Not this spec's concern; not fixed here.

## Visual impact

The sidebar's top region changes for single-root workspaces: a new `▾ 📁 <folder>` header row appears above
the section list (previously absent), and the Project Handoff chip moves from its own right-aligned bar
into that header. Multi-root is visually unchanged. Verified against the mock at
`/tmp/mission-control/sidebar.html` (three variants: today / proposed single-root / multi-root unchanged).

## Sources consulted

- Pin `p-cf707f` (full decided design + rejected alternatives).
- `/tmp/mission-control/sidebar.html` — visual mock, three side-by-side variants.
- `src/webview/sidebar/App.tsx` — existing `HandoffBtn`, `.handoff-bar` (single-root), `.grp.folder`
  (multi-root) render paths.
- `src/webview/sidebar/sidebar.css` — existing `.handoff-bar` / `.grp.folder` / `.handoff-btn` rules.
- `src/webview/SidebarPrototype.ts::gatherOne` (line ~451) — confirms `FleetVM.folder` is already set
  unconditionally per workspace, no host-side change needed.
- `src/sidebar/types.ts` — `FleetVM`, `WorkspaceRef`, `HandoffVM`, `SAMPLE` fixture.
- `test/unit/sidebarPrototype.test.ts`, `sidebarSearch.test.ts`, `sidebarActions.test.ts` — confirmed none
  assert on `.handoff-bar` / `HandoffBtn` DOM structure directly (host-side data tests only).
