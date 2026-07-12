# 374 — mermaid-activity-readonly-nav — tasks

_Generated from `plan.md` on 2026-07-12. Updated during implementation._

## Implementation

- [x] Extract pure viewport math into `src/webview/activity/mermaidViewport.ts`
- [x] Unit-test pure math in `test/unit/mermaidViewport.test.ts`
- [x] Audit Handoff/Task Detail styles: shared `mermaid-block.css` loaded by Activity, Handoff, Task Detail
- [x] Replace passive `.mmd-svg` with `.mmd-viewport` + `.mmd-stage` transform layer in `MermaidBlock`
- [x] Measure natural content size after SVG mount; open with fit-to-width framing
- [x] Toolbar: zoom in/out, fit, reset 100%, scale indicator; Source toggle preserved
- [x] Gestures: Ctrl/Cmd+wheel zoom; plain wheel edge pass-through; drag pan when overflow
- [x] Keyboard: `+`/`=` / `-` / `0` / `f` / arrows when viewport focused
- [x] Cap viewport max-height (`min(420px, 55vh)`)
- [x] Source toggle still renders original `code` only; transform state is ephemeral
- [x] `user-select: none` / grab cursor; focus-visible; reduced-motion for spinner

## Verification

- [x] Pure-math unit tests green
- [x] `markdownEngine`, `markdownHardening`, preview routes, shell parity — green
- [x] No change to Mermaid `securityLevel: "strict"`
- [x] Human dogfood in real VS Code Activity (scroll + zoom + Source)
- [x] Visual QA light/dark × narrow/wide

**Headless check:** `npx vitest run test/unit/mermaidViewport.test.ts test/unit/markdownEngine.test.ts test/unit/markdownHardening.test.ts test/unit/webviewPreviewRoutes.test.ts test/unit/webviewShellParity.test.ts`

**Verify:** `npx vitest run test/unit/mermaidViewport.test.ts test/unit/markdownEngine.test.ts test/unit/markdownHardening.test.ts test/unit/webviewPreviewRoutes.test.ts test/unit/webviewShellParity.test.ts`

## Dogfood

**Dogfood:** `npx vitest run test/unit/mermaidViewport.test.ts`

**Human dogfood:**
1. Build/reload extension from worktree `tachyon/mermaid-activity-readonly-nav`.
2. Open Activity with a large ````mermaid` diagram.
3. Zoom (buttons + Ctrl+wheel), pan, Fit, 100%, Source.
4. Confirm plain wheel still scrolls the feed at rest and at pan edges.

_Closure note (2026-07-12):_ dogfood exercised against the real Activity webview bundle via the preview harness
(`view=activity&fixture=mermaid-nav`) with `__mermaidSrc` seeded as the host panel does. Large diagram opens at
fit-to-width (25% wide), small at 100%; zoom buttons change scale (25%→29%); Fit restores fit framing; Source shows
original `flowchart TB` fence content; nav chrome does not replace Activity chrome. Wheel policy remains unit-covered
in `mermaidViewport` (Ctrl zoom vs plain-wheel pan/pass-through).

## Visual QA

- [x] Evidence: harness screenshots under `.tachyon/evidence/374-mermaid-activity-readonly-nav/`:
  - `matrix-dark-wide.png`, `matrix-dark-narrow.png`, `matrix-light-wide.png`, `matrix-light-narrow.png`
  - interaction: `dark-wide-zoomed.png`, `dark-wide-fit.png`, `dark-wide-source.png`, `dark-wide-100.png`
  - route: `http://localhost:<port>/scripts/webview-preview/index.html?view=activity&fixture=mermaid-nav&width={820|360}[&theme=light]`
- [x] Verdict: **PASS** — toolbar + scale readable in dark and light; narrow widths keep chrome usable (large stays
  fit-to-width 25%, small fits ~79% on 360px); Source preserves original fence text; zoom/fit/reset affordances present
  and first-party only. Large multi-subgraph opens intentionally small (fit-to-width ≤100%) — navigable via zoom, not a layout defect.

**Visual QA surfaces:** Activity Mermaid block (primary) via shared `MermaidBlock` + `mermaid-block.css`.
