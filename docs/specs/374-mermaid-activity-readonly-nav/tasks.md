# 374 — mermaid-activity-readonly-nav — tasks

_Generated from `plan.md` on 2026-07-12. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [ ] Extract pure viewport math (`clampScale`, `fitScale`, `zoomAtPoint`, `clampPan`) into `src/webview/activity/mermaidViewport.ts` (or equivalent) with no DOM imports
- [ ] Unit-test pure math in `test/unit/mermaidViewport.test.ts` (fit never upscales past 1 when opening; zoom-at-point stability; pan clamps; scale bounds)
- [ ] Audit Handoff stylesheet path: confirm whether `activity.css` rules apply to `MarkdownView` in Handoff; if not, place shared Mermaid viewport rules where both surfaces load them
- [ ] Replace passive `.mmd-svg { max-width:100% }` stage with `.mmd-viewport` + `.mmd-stage` transform layer in `MermaidBlock`
- [ ] Measure natural content size after SVG mount; open with fit-to-width framing equivalent to today's behavior
- [ ] Add toolbar controls: zoom in, zoom out, fit, reset 100%, scale indicator — keep Source toggle byte-faithful
- [ ] Wire gestures: Ctrl/Cmd+wheel zoom toward cursor; plain wheel pass-through / edge pass-through; drag pan when overflow
- [ ] Wire keyboard when viewport focused: `+`/`=` / `-` / `0` / `f` / arrows (document in `aria-label` or title)
- [ ] Cap viewport max-height so extreme zoom does not unbounded-grow the Activity feed item
- [ ] Ensure Source toggle still renders original `code` only; reset ephemeral transform when leaving diagram view
- [ ] `user-select: none` / grab cursor during pan; focus-visible styles; reduced-motion friendly (no required animation)

## Verification

- [ ] Small diagram: readable at default without interaction
- [ ] Large diagram (e.g. 368 `system-design.mmd` content): zoom, pan, fit, reset without irrecoverable clip
- [ ] Plain wheel outside viewport and at unzoomed / pan edges scrolls Activity
- [ ] Keyboard path works with focus on viewport/controls
- [ ] Source shows original fence content byte-for-byte
- [ ] No change to Mermaid `securityLevel: "strict"`; no new diagram-sourced script execution path
- [ ] Existing unit tests: `markdownEngine`, `markdownHardening`, webview shell — remain green
- [ ] New pure-math unit tests green

**Headless check:** `npx vitest run test/unit/mermaidViewport.test.ts test/unit/markdownEngine.test.ts test/unit/markdownHardening.test.ts`

**Verify:** `npx vitest run test/unit/mermaidViewport.test.ts test/unit/markdownEngine.test.ts test/unit/markdownHardening.test.ts`

## Dogfood

**Dogfood:** `npx vitest run test/unit/mermaidViewport.test.ts`

**Human dogfood:**
1. Open Activity on a conversation/message containing a large ````mermaid` flowchart (or paste 368 `system-design.mmd` into an agent message fixture).
2. Confirm default framing is readable; zoom with buttons and Ctrl+wheel; pan by drag; Fit; 100%; Source unchanged.
3. Scroll the feed with plain wheel above/below the diagram and at pan limits — feed must move.
4. Tab to controls / viewport; exercise keyboard shortcuts.
5. Toggle VS Code light/dark (or code theme force) and narrow the panel.

## Visual QA

- [ ] Evidence: screenshots under `.tachyon/vqa/` or notes — light/dark × narrow/wide, diagram zoomed + toolbar visible
- [ ] Verdict: controls readable, no feed trap-scroll, Source intact, scale indicator correct

**Visual QA surfaces:** Activity Mermaid block; Handoff Mermaid if stylesheet shared.
