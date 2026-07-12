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
- [ ] Human dogfood in real VS Code Activity (scroll + zoom + Source)
- [ ] Visual QA light/dark × narrow/wide

**Headless check:** `npx vitest run test/unit/mermaidViewport.test.ts test/unit/markdownEngine.test.ts test/unit/markdownHardening.test.ts test/unit/webviewPreviewRoutes.test.ts test/unit/webviewShellParity.test.ts`

**Verify:** `npx vitest run test/unit/mermaidViewport.test.ts test/unit/markdownEngine.test.ts test/unit/markdownHardening.test.ts test/unit/webviewPreviewRoutes.test.ts test/unit/webviewShellParity.test.ts`

## Dogfood

**Dogfood:** `npx vitest run test/unit/mermaidViewport.test.ts`

**Human dogfood:**
1. Build/reload extension from worktree `tachyon/mermaid-activity-readonly-nav`.
2. Open Activity with a large ````mermaid` diagram.
3. Zoom (buttons + Ctrl+wheel), pan, Fit, 100%, Source.
4. Confirm plain wheel still scrolls the feed at rest and at pan edges.

## Visual QA

- [ ] Evidence:
- [ ] Verdict:

**Visual QA surfaces:** Activity Mermaid block (primary).
