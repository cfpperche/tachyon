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

_(none yet — implementation not started)_

## Deviations

_(none yet)_
