# 331 — sidebar-workspace-identity-line

_Created 2026-07-02._

**Status:** shipped
**Closure:** Shipped locally 2026-07-02 — `App.tsx`'s folder header is now the single, always-present
render path for both single-root and multi-root (the `!multi`-gated `.handoff-bar` special case is gone);
`HandoffBtn` renamed "distill" → "handoff" and goes quiet (glyph-only) when fresh with nothing pending.
Evidence: `npx tsc --noEmit`, `npx tsc -p tsconfig.webview.json --noEmit`, full `vitest run` (all green
except the pre-existing, unrelated `auth.test.ts` tool-count drift from concurrent out-of-scope spec-325
work — reproduced identically with this spec's diff stashed out), and the declared `/sdd verify` commands
(logged in `notes.md`).
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Verify:** `npx tsc -p tsconfig.webview.json --noEmit`
**Verify:** `env -u TMUX npx vitest run test/unit/sidebarPrototype.test.ts test/unit/sidebarSearch.test.ts test/unit/sidebarActions.test.ts test/unit/webviewPreviewCatalog.test.ts test/unit/webviewPreviewRoutes.test.ts`

## Intent

Decided in pin `p-cf707f`. Root cause: in multi-root the Project Handoff chip already lives correctly in
the folder header (`.grp.folder`); in single-root there is no folder header, so the chip sat alone in its
own `.handoff-bar` — a whole row for one item, with no semantic anchor. That bar got worse after spec 322
removed the probes chip and left it holding exactly one item.

The fix is not to relocate the chip again — it's to kill the special case that orphaned it. The folder
header becomes the **workspace identity line**, always present: single-root is multi-root with N=1, one
render path. The line pays for itself even without the chip: single-root today shows the workspace name
nowhere (useful with several windows open), and it becomes the natural slot for future per-folder chrome
(a Mission Control entry, branch/worktree).

Two chip refinements ride along, both decided in the same pin: the label "distill" (cryptic) becomes
"handoff", and the chip goes quiet — glyph only, no text — when the handoff is fresh with nothing pending
(noise proportional to pending action, not a decoration that's always on).

Multi-root is unchanged; it becomes the only code path instead of one of two.

## Acceptance criteria

- [x] **Scenario: single-root shows the workspace identity line**
  - **Given** a single-root Tachyon workspace
  - **When** the sidebar renders
  - **Then** a folder header (`▾ 📁 <folder name>`) is always present above the section list, with the
    Project Handoff chip anchored inside it — there is no separate `.handoff-bar`
- [x] **Scenario: multi-root is unaffected**
  - **Given** a multi-root Tachyon workspace
  - **When** the sidebar renders
  - **Then** each folder still gets its own collapsible header with its own Project Handoff chip, exactly
    as before
- [x] **Scenario: quiet chip when nothing is pending**
  - **Given** a folder's Project Handoff is fresh with zero pending notes
  - **When** its chip renders
  - **Then** only the glyph (◆) is shown, no text label
- [x] **Scenario: noisy chip when action is pending**
  - **Given** a folder's Project Handoff needs distill, is possibly stale, or is old
  - **When** its chip renders
  - **Then** the chip shows the glyph plus a label (staleness tone carries via CSS class: quiet for fresh,
    amber/warn for needs-distill or possibly-stale, strong/err for old)
- [x] The chip's label text says "handoff", never "distill".
- [x] `.handoff-bar` and its CSS no longer exist anywhere in the sidebar webview.
- [x] Single-root and multi-root share one render path in `App.tsx` (no `!multi` branch gating the folder
  header or `HandoffBtn` placement).

## Non-goals

- Not touching the Bridge footer line (rejected in the pin: global status vs. per-folder handoff is
  ambiguous in multi-root).
- Not touching the view-title/tab icons (rejected in the pin: no dynamic count badge support there).
- Not changing `ProjectHandoffStore`, the distill flow, or the Handoff panel itself (spec 328, in flight
  concurrently) — this spec only touches where and how the sidebar's open-affordance chip renders.
- Not adding new per-folder chrome (Mission Control entry, branch/worktree) — the identity line is built to
  make that possible later, not to add it now.

## Open questions

None outstanding — the pin already resolved the design fork (kill the special case vs. relocate the chip)
and the two rejected alternatives (Bridge footer, view-title).
