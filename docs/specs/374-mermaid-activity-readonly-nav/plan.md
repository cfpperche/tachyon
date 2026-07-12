# 374 — mermaid-activity-readonly-nav — plan

_Drafted from `spec.md` + codebase research on 2026-07-12 (task `t-3febb9`). The approach, not the steps (those go in `tasks.md`)._

## Approach

Keep Mermaid **render security and Source fidelity unchanged**. Add a thin **first-party viewport chrome** around the already-rendered SVG:

1. After Mermaid returns SVG (still `securityLevel: "strict"`, still injected into a host-owned node), wrap it in a confined viewport with an inner transform layer (`translate` + `scale`).
2. Own zoom/pan state in Preact component state only (ephemeral).
3. Expose toolbar controls: zoom in/out, fit, reset 100%, scale label — plus keyboard when the viewport/chrome is focused.
4. Apply a strict wheel policy so Activity's window-scroll + bottom-stick model is not hijacked.
5. Leave Source path on the original `code` string; toggle resets ephemeral transform state on remount/view switch as needed.

No new npm dependency for pan/zoom unless pure transform math proves insufficient (it should not for v1).

```
.mmd
  .mmd-bar          (existing label + Source toggle; extend with nav controls OR sub-bar)
  .mmd-viewport     (overflow:hidden; focusable; captures pointer for pan when allowed)
    .mmd-stage      (transform: translate(x,y) scale(s); transform-origin: 0 0 or cursor-aware)
      svg           (mermaid output — pointer-events limited as needed)
  .mmd-src | .mmd-loading  (unchanged paths)
```

**Math (pure helpers, unit-tested):**

- `clampScale(s)` — e.g. 0.25 … 4 (tune after dogfood)
- `fitScale(viewportW, viewportH, contentW, contentH)` — min ratio, capped at 1 for “open fitted but never upscale small diagrams past natural”
- `panAtBounds` / edge pass-through for wheel when zoomed
- Zoom-toward-point: adjust `tx,ty` so the content point under the cursor stays stable when scale changes

**Initial framing:**

- Measure natural SVG size after render (or from SVG attributes when present).
- Open at **fit-to-width** (match today's feel: small diagrams ~natural; large diagrams shrunk to width). Display that as the current % relative to natural 100%.
- **Reset 100%** jumps to natural scale (may overflow viewport → pan enabled).
- **Fit** recomputes fit into the current viewport.

**Gesture policy (v1):**

| Input | Behavior |
|-------|----------|
| `Ctrl`/`Cmd` + wheel | Zoom toward cursor; `preventDefault` only when over viewport |
| Pinch (if `wheel` with `ctrlKey` on trackpads) | Same as ctrl+wheel |
| Plain wheel, scale at open-fit / no overflow | Do **not** preventDefault → Activity scrolls |
| Plain wheel when zoomed and content overflows | Pan within bounds; at edge, stop preventing so Activity can scroll |
| Pointer drag on stage when overflow exists | Pan; `cursor: grab` / `grabbing` |
| Buttons `+` `−` Fit `100%` | Always work; focusable |
| Keyboard (focused viewport) | `+`/`=` zoom in, `-` zoom out, `0` reset 100%, `f` fit, arrows pan |

**Accessibility:**

- Viewport: `tabindex="0"`, `role="group"`, `aria-label` including current scale
- Buttons: `aria-label` / visible titles; use codicons consistent with Activity chrome
- Respect `prefers-reduced-motion` (no animated zoom transitions required; snaps are fine)

**Security invariants (unchanged fail-closed):**

- Do not parse Mermaid into editable AST for UI
- Do not change `securityLevel: "strict"`
- Do not DOMPurify-relax or add diagram-sourced event handlers
- First-party chrome only; SVG remains passive content under transform
- No message/file/handoff mutation; no postMessage for zoom state
- Source path continues to highlight the original `code` prop only

**Tests:**

- Pure transform/fit helpers in Node unit tests
- Existing `markdownEngine` / hardening tests remain green
- Optional: preview fixture with a large ````mermaid` block for visual QA (today Activity preview fixture deliberately omits mermaid — add a dedicated fixture or local HTML sample, do not poison the vendor-free default fixture)

## Key decisions

- **CSS transform viewport, not SVG viewBox rewriting** — chosen because it keeps Mermaid's SVG untouched (Source/render path stable) and is easy to reason about for pan/zoom; rejected viewBox mutation because it couples to Mermaid internal SVG structure and complicates reset/fit.
- **No panzoom library** — chosen to avoid bundle weight and new supply-chain surface in the Activity webview; rejected `panzoom`/`svg-pan-zoom` unless pure code hits a hard wall.
- **Ctrl/Cmd+wheel for zoom; plain wheel prefers Activity** — chosen to satisfy acceptance “scroll preservado”; rejected “always capture wheel while hovering diagram” because Activity is a long feed and trap-scroll is the top UX risk.
- **Implement on shared `MermaidBlock`** — chosen because Handoff already reuses `MarkdownView` and has the same large-diagram problem; rejected Activity-only wrapper that forks two Mermaid UIs.
- **Ephemeral state only** — chosen per task invariants; rejected localStorage / message-keyed persistence.
- **Toolbar always visible when diagram shows** (compact, muted) — chosen so wheel-less / keyboard users discover controls; rejected hover-only chrome that fails a11y and touch.
- **Do not route through image lightbox** — chosen because diagrams need persistent context in the feed thread; fullscreen would break Source adjacency and scroll position.

## Files touched

| File | Change |
|------|--------|
| `src/webview/activity/markdown.tsx` | Extend `MermaidBlock` with viewport, transform state, gestures, toolbar; extract pure helpers (same file or small sibling module) |
| `src/webview/activity/mermaidViewport.ts` (new, optional) | Pure `fitScale` / clamp / zoom-at-point / pan-clamp — Node-testable, no DOM |
| `src/webview/activity/activity.css` | `.mmd-viewport`, `.mmd-stage`, control cluster, focus, grab cursor, max-height for large diagrams |
| `test/unit/mermaidViewport.test.ts` (new) | Unit tests for pure math |
| `scripts/webview-preview/fixtures/…` (optional) | Mermaid-heavy fixture for visual dogfood — **not** the default vendor-free activity fixture |
| `docs/specs/374-…/{spec,plan,tasks,notes}.md` | This SDD |

Unlikely needed: `ActivityPanel.ts` CSP (no new script sources), `esbuild.mjs` (no new entry unless split), Bridge/protocol.

## Risks & unknowns

1. **Wheel / trackpad variance** — Chromium/Electron reports trackpad pinch as `wheel` + `ctrlKey`; verify in real VS Code webview on Linux/Windows/macOS if available. Policy must degrade: buttons always work.
2. **Activity bottom-stick + height changes** — zooming grows visual size inside a max-height viewport should **not** reflow the whole feed unbounded; use a fixed/max viewport height so stick math stays stable (related to spec 238 content-visibility / EDH notes).
3. **SVG measurement** — some Mermaid diagrams use `width="100%"` in SVG; need fallback measurement via `getBBox` / `getBoundingClientRect` after mount without applying `max-width:100%` on the live stage (that CSS fights transform zoom today — must remove it from the stage path).
4. **Pointer vs text selection** — drag pan must not select text inside SVG labels awkwardly; `user-select: none` on stage during pan.
5. **Touch** — single-finger pan when overflow; pinch if browser fires ctrl+wheel; no multi-touch library in v1.
6. **Security narrative** — SVG still goes through `dangerouslySetInnerHTML` as today; this feature must not widen that. Do not add `foreignObject` interactivity.
7. **Shared Handoff CSS** — Handoff imports markdown rendering but may not load full `activity.css`; verify which stylesheet Handoff uses and either share rules or duplicate minimal viewport CSS where needed.

## Visual impact

- Surface: Activity agent messages with ````mermaid` blocks; Handoff body when it contains Mermaid.
- Visible adds: small control cluster on the diagram bar (or adjacent), scale %, grab cursor when pannable, focus ring on viewport.
- Risk: toolbar clutter on tiny diagrams; mitigate with compact muted controls and no modal overlay.
- Proof: screenshots light/dark × narrow/wide with large diagram zoomed; Evidence/Verdict in `tasks.md` / `notes.md`.

## Sources consulted

- Task `t-3febb9` body (acceptance matrix, invariants, non-goals)
- `src/webview/activity/markdown.tsx` — `MermaidBlock`, on-demand load, `securityLevel: "strict"`, svg cache, Source toggle, `dangerouslySetInnerHTML`
- `src/webview/activity/activity.css` — `.mmd` / `.mmd-svg` (`max-width: 100%`, `overflow-x: auto`)
- `src/webview/activity/main.tsx` — window scroll, bottom-stick, loadOlder prepend anchor
- `src/webview/activity/App.tsx` — image lightbox (contrast pattern: modal zoom for images, not diagrams)
- `src/webview/handoff/App.tsx` — reuses `MarkdownView`
- `src/webview/activity/markdownSanitizeConfig.ts` — DOMPurify options for markdown (Mermaid path is separate)
- `esbuild.mjs` — mermaid on-demand IIFE bundle
- `package.json` — `mermaid` ^11.15.0
- `docs/specs/238-tachyon-runtime-activity-view/*` — feed scroll / mermaid async height risk
- `docs/specs/280-webview-convention-consistency/spec.md` — bootstrap globals / CSP shell
- Motivating large diagram: `docs/specs/368-delivery-worktree-leases/system-design.mmd` (~92 lines, multi-subgraph)
- `scripts/webview-preview/fixtures/activity.ts` — default fixture intentionally vendor-free (no mermaid)
