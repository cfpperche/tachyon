# 331 — sidebar-workspace-identity-line — notes

_Created 2026-07-02._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- **Consolidated `HandoffBtn`'s markup from two spans to one.** The pre-existing code rendered an
  always-on `<span aria-hidden>◆</span>` *plus* a badge whose text already started with a glyph
  (`◆ distill · 55`), so non-quiet states doubled the diamond. The mock
  (`/tmp/mission-control/sidebar.html`) shows exactly one glyph per chip in every variant, including the
  "hoje" (today) callout that visualizes this as part of the orphan-bar problem. Fixing the double-glyph
  wasn't separately called out in the pin text but falls directly out of implementing the quiet-mode
  requirement ("só o glifo ◆") faithfully and matches the mock pixel-for-pixel, so folded it in rather than
  filing a follow-up for an obviously-wrong-looking chip in the same component this spec touches.
- **`SAMPLE.folder`/`SAMPLE.handoff` were unset before this spec** — the comment on `FleetVM.folder` said
  "set when >1 root", which was only ever true on the *host* build path (`SidebarPrototype.ts::gatherOne`
  sets it unconditionally already); the fixture just never carried it. Added both so the default
  dev-preview render — and this spec's own visual verdict — reflects the new always-present header instead
  of an artifact of a stale fixture.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Verification log

### 2026-07-02T19:10:26Z — pass (2/2) — source: tasks.md
- `npx tsc -p tsconfig.webview.json --noEmit` — pass
- `env -u TMUX npx vitest run test/unit/sidebarPrototype.test.ts test/unit/sidebarSearch.test.ts test/unit/sidebarActions.test.ts test/unit/webviewPreviewCatalog.test.ts test/unit/webviewPreviewRoutes.test.ts` — pass
