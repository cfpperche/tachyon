# 374 — mermaid-activity-readonly-nav

_Created 2026-07-12 from Mission Control task `t-3febb9`._

**Status:** in-progress

## Intent

The Activity feed already renders fenced ````mermaid` blocks as SVG diagrams (on-demand Mermaid load, `securityLevel: "strict"`, diagram↔Source toggle). Large diagrams — e.g. multi-subgraph architecture charts in handoff/agent output — only get a passive `max-width: 100%` fit-to-width and horizontal overflow. They stay hard to inspect: no zoom, no pan, no fit/reset, no scale feedback, and no keyboard path.

**Done** means the rendered Mermaid preview gains **strictly visual, read-only navigation** inside a confined viewport: zoom (wheel/trackpad + accessible controls), pan when magnified, fit-to-view and reset to 100%, a live scale indicator, and predictable keyboard/focus behavior — without editing the diagram, mutating messages, weakening sanitization/CSP, or stealing Activity scroll.

This also applies wherever `MarkdownView` is reused (Handoff body, Task Detail body today), because the Mermaid block is a shared component; the product goal is Activity readability, the implementation surface is the shared Mermaid block plus shared CSS.

## Acceptance criteria

- [x] **Scenario: small diagram stays legible without interaction**
  - **Given** a Mermaid block whose natural SVG size fits the available width
  - **When** the diagram finishes rendering
  - **Then** it appears fully visible at a sensible default (no forced empty zoom chrome that hides content)
  - **And** the user can read it without zoom/pan
  - _Impl: `initialTransform` / `fitWidthScale` never upscales past 1; compact toolbar_

- [x] **Scenario: large diagram supports zoom, pan, fit, and reset**
  - **Given** a Mermaid block wider/taller than the viewport
  - **When** the user zooms in, pans by drag, uses fit-to-view, and resets to 100%
  - **Then** the diagram remains navigable without irrecoverable clipping
  - **And** fit/reset restore a predictable framing

- [x] **Scenario: Activity scroll is preserved**
  - **Given** a Mermaid diagram is visible in the Activity feed
  - **When** the user scrolls with the wheel/trackpad outside the diagram viewport, or at pan limits / unzoomed state per the gesture policy
  - **Then** the Activity feed scrolls normally
  - **And** the diagram does not permanently capture wheel events
  - _Impl: Ctrl/Cmd+wheel zooms; plain wheel only `preventDefault` when pan actually moves_

- [x] **Scenario: keyboard and focus affordances**
  - **Given** the diagram viewport can receive focus
  - **When** the user uses `+`/`-`/`0`/`f`/arrows or toolbar buttons
  - **Then** navigation works without requiring a mouse

- [x] **Scenario: Source remains byte-for-byte original**
  - **Given** a rendered Mermaid block
  - **When** the user toggles Source
  - **Then** the displayed source matches the original fenced content byte-for-byte
  - **And** zoom/pan state does not rewrite the Mermaid source

- [x] **Scenario: hostile Mermaid stays fail-closed**
  - **Given** Mermaid content that attempts scripts or handlers
  - **When** it is rendered under existing `securityLevel: "strict"` and Activity CSP
  - **Then** navigation chrome is first-party only; diagram path unchanged for security

- [ ] **Scenario: visual QA across theme and width**
  - **Given** light and dark code themes and narrow vs wide Activity viewports
  - **When** a representative diagram is navigated
  - **Then** controls remain readable (pending human / agent visual pass in real VS Code)

- [x] Zoom controls include accessible buttons (not wheel-only).
- [x] A current scale indicator is visible while the diagram view is active.
- [x] Zoom/pan state is ephemeral and local to the live diagram view.
- [x] Interaction is confined to the diagram viewport; it does not block general Activity navigation.

## Non-goals

- Mermaid editor / live re-render from edited source
- Persisted layout, saved zoom, or per-message view state
- Export (PNG/SVG download), print, or collaboration cursors
- Changing Mermaid grammar, themes beyond existing light/dark, or the on-demand load pipeline
- Replacing `securityLevel: "strict"`, CSP, or introducing `eval`/inline handlers from diagram content
- Fullscreen lightbox (image lightbox is a separate pattern; this stays inline)
- Non-Mermaid diagram languages
- Changing Handoff content model or Bridge protocols
- Wiring `__mermaidSrc` into Handoff/Task Detail shells (pre-existing gap; CSS shared, Activity remains the bootstrapped surface)

## Open questions

_Resolved:_

1. **Gesture policy** — Ctrl/Cmd+wheel zoom; plain wheel prefers Activity; edge pass-through when zoomed.
2. **Shared component** — `MermaidBlock` + `mermaid-block.css` shared; Handoff/Task Detail get chrome when/if mermaid bootstrap exists.
3. **100%** — natural SVG size; open ≈ fit-to-width ≤ 100%.
