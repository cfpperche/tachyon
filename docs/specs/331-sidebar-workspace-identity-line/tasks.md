# 331 — sidebar-workspace-identity-line — tasks

_Generated from `plan.md` on 2026-07-02. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] `App.tsx`: rename `HandoffBtn`'s "distill" label to "handoff"; collapse the two-span markup (outer
  `aria-hidden` glyph + badge) into one badge span; add quiet mode (glyph-only text) when the handoff
  exists, is fresh, and has zero pending notes.
- [x] `App.tsx`: delete the `!multi && fleets[0] && <div class="handoff-bar">…</div>` block.
- [x] `App.tsx`: collapse `{!multi ? renderFolder(fleets[0]) : fleets.map(...)}` into an unconditional
  `fleets.map(...)` over the folder-header + collapsible-body render path.
- [x] `sidebar.css`: remove the `.handoff-bar` rule, its mention in the `flex: 0 0 auto` selector list, and
  the now-dead `.handoff-btn > span[aria-hidden]` rule; refresh stale comments.
- [x] `src/sidebar/types.ts`: add `folder` + `handoff` to `SAMPLE` (neutral `demohash`/`Demo` convention)
  so the dev-preview harness shows the identity line by default.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] `grep -rn "handoff-bar" src/` returns nothing.
- [x] `App.tsx` has no `!multi` conditional around the folder header or `HandoffBtn`.
- [x] `npx tsc --noEmit` and `npx tsc -p tsconfig.webview.json --noEmit` are clean.
- [x] `env -u TMUX npx vitest run` — all suites green except the pre-existing, unrelated
  `test/unit/auth.test.ts` tool-count failure (spec-325 concurrent work, out of scope; reproduced
  identically with this spec's diff stashed out).

**Headless check:** `npx tsc -p tsconfig.webview.json --noEmit`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

**Verify:** `npx tsc -p tsconfig.webview.json --noEmit`
**Verify:** `env -u TMUX npx vitest run test/unit/sidebarPrototype.test.ts test/unit/sidebarSearch.test.ts test/unit/sidebarActions.test.ts test/unit/webviewPreviewCatalog.test.ts test/unit/webviewPreviewRoutes.test.ts`

## Dogfood

**Dogfood-Opt-Out:** Pure Preact render-path/markup change with no new host↔webview message, command, or
data flow to exercise headlessly beyond what `tsc` + the existing sidebar/preview unit suites already
cover; the actual behavior (does the identity line look right) is a visual question, addressed under
Visual QA below via the dev-preview harness and the design mock, not a headless dogfood.

**Human dogfood:** optional — open the sidebar webview (`npm run webview:preview` sidebar route, or the
real extension in a single-root workspace) and confirm the folder header + Project Handoff chip render
where the mock (`/tmp/mission-control/sidebar.html`, "Proposta" variant) shows them.

## Visual QA

- [x] Evidence: `/tmp/mission-control/sidebar.html` (three-variant mock: hoje / proposta single-root /
  multi-root unchanged) used as the visual contract for this change; `scripts/webview-preview/fixtures/`
  `sidebar.ts`'s `default` fixture (now via `SAMPLE`, which carries `folder` + a `needs_distill` `handoff`)
  exercises the non-quiet chip in the dev-preview harness.
- [x] Verdict: implementation matches the "Proposta" mock — single-root now renders `▾ 📁 <folder> [chip]`
  as the identity line, chip reads "handoff" not "distill", `.handoff-bar` is gone. Multi-root path is
  byte-for-byte the same JSX it always was, just no longer gated by a `!multi` check.
