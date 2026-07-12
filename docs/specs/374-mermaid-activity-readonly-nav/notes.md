# 374 — mermaid-activity-readonly-nav — notes

_In-flight design memory. Empty at scaffold; filled during research/implementation._

## Research log (2026-07-12)

### Current Mermaid path

- Fences split in `markdownEngine.segments` → `MermaidBlock` in `markdown.tsx`.
- On-demand script load from `window.__mermaidSrc` (esbuild target `dist/webview/mermaid.js`).
- Init: `{ startOnLoad: false, securityLevel: "strict", theme: mermaidTheme() }`.
- SVG cached in-module (`theme::code` key, max 64).
- Render failure → forced Source; Source uses `highlight(code, "mermaid")` on the original prop.
- SVG injected via `dangerouslySetInnerHTML` — same as today; DOMPurify applies to markdown HTML segments only, not Mermaid SVG.

### CSS today

```css
.mmd-svg { padding: 10px; overflow-x: auto; }
.mmd-svg svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
```

This is width-fit only. It **fights** transform zoom (must leave the stage path).

### Scroll model

- Activity uses **window** scroll + bottom-stick (`main.tsx`).
- Capturing `wheel` without a tight policy will trap the feed — top product risk.

### Shared surfaces

- `MarkdownView` used by Activity messages and Handoff body.
- Image zoom is a **fullscreen lightbox** — not a template for diagrams.

### Motivating content

- Task `artifact_refs` point at `docs/specs/368-delivery-worktree-leases` and `system-design.mmd` as relation examples (large multi-subgraph chart), not as code deps.

### Defaults ratified in plan (pending human OK)

1. Ctrl/Cmd+wheel zoom; plain wheel prefers Activity.
2. Shared `MermaidBlock` (Handoff inherits).
3. 100% = natural size; open ≈ fit-to-width ≤ 100%.

## Decisions during build

- Shared CSS file `src/webview/shared/mermaid-block.css` copied to `dist/webview/` and linked from Activity, Handoff, Task Detail (+ preview routes). Keeps MarkdownView mermaid chrome consistent without stuffing design-system.
- Stage uses `innerHTML = svg` (same trust model as previous `dangerouslySetInnerHTML`) so transform wrappers stay first-party.
- Handoff/Task Detail still lack `__mermaidSrc` bootstrap (pre-existing) — CSS is ready; render still only works where mermaid is bootstrapped (Activity).

## Deviations

- None material from plan.
- Closure dogfood used the **preview harness** (real Activity bundle + synthetic `mermaid-nav` fixture) rather than a
  live Extension Development Host session. Same `MermaidBlock` / CSS / mermaid bootstrap path as the host panel;
  `__mermaidSrc` is now seeded by `scripts/webview-preview/preview.ts` so fences render outside VS Code.

## Implementation location

- Landed on main as `c5f9aee0` (`feat(t-3febb9): read-only zoom/pan nav for Activity Mermaid previews`).
- Closure follow-up: harness fixture `mermaid-nav`, `theme-light.css`, preview `?theme=` / `?width=` helpers.

## Verification log

### 2026-07-12 — verify (declared suite)

```
npx vitest run test/unit/mermaidViewport.test.ts test/unit/markdownEngine.test.ts \
  test/unit/markdownHardening.test.ts test/unit/webviewPreviewRoutes.test.ts \
  test/unit/webviewShellParity.test.ts test/unit/webviewPreviewActivityFixture.test.ts
```

Result: **pass** — 6 files, 57 tests.

### 2026-07-12T18:20:31Z — pass (1/1) — source: tasks.md
- `npx vitest run test/unit/mermaidViewport.test.ts test/unit/markdownEngine.test.ts test/unit/markdownHardening.test.ts test/unit/webviewPreviewRoutes.test.ts test/unit/webviewShellParity.test.ts` — pass

## Dogfood log

### 2026-07-12 — headless dogfood

```
npx vitest run test/unit/mermaidViewport.test.ts
```

Result: **pass** — 12 pure-math tests (zoom step, fit-width cap, pan bounds, wheel policy inputs).

### 2026-07-12 — harness dogfood (Activity mermaid-nav)

- Server: `PREVIEW_PORT=5199 npm run preview:webview`
- Route: `?view=activity&fixture=mermaid-nav&width=820|360[&theme=light]`
- Observed: large diagram scale **25%** (fit-to-width), small **100%** (wide) / **79%** (narrow 360px)
- Zoom in buttons: **25% → 29%**; Fit restores fit framing; Source shows original `flowchart TB` fence text
- Evidence dir: `.tachyon/evidence/374-mermaid-activity-readonly-nav/`

### 2026-07-12T18:20:32Z — pass (1/1) — source: tasks.md — commit: e176d9a4900793c43ff1dbfb836d063943f717cc
- `npx vitest run test/unit/mermaidViewport.test.ts` — pass

## Visual QA

- Matrix: dark/light × wide(820)/narrow(360) — controls + scale readable; no chrome clipping
- Interaction: zoomed, fit, source, 100% reset captured
- Verdict: **PASS**
