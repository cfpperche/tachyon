# 374 — mermaid-activity-readonly-nav

_Created 2026-07-12 from Mission Control task `t-3febb9`._

**Status:** draft

## Intent

The Activity feed already renders fenced ````mermaid` blocks as SVG diagrams (on-demand Mermaid load, `securityLevel: "strict"`, diagram↔Source toggle). Large diagrams — e.g. multi-subgraph architecture charts in handoff/agent output — only get a passive `max-width: 100%` fit-to-width and horizontal overflow. They stay hard to inspect: no zoom, no pan, no fit/reset, no scale feedback, and no keyboard path.

**Done** means the rendered Mermaid preview gains **strictly visual, read-only navigation** inside a confined viewport: zoom (wheel/trackpad + accessible controls), pan when magnified, fit-to-view and reset to 100%, a live scale indicator, and predictable keyboard/focus behavior — without editing the diagram, mutating messages, weakening sanitization/CSP, or stealing Activity scroll.

This also applies wherever `MarkdownView` is reused (Handoff body today), because the Mermaid block is a shared component; the product goal is Activity readability, the implementation surface is the shared Mermaid block.

## Acceptance criteria

- [ ] **Scenario: small diagram stays legible without interaction**
  - **Given** a Mermaid block whose natural SVG size fits the available width
  - **When** the diagram finishes rendering
  - **Then** it appears fully visible at a sensible default (no forced empty zoom chrome that hides content)
  - **And** the user can read it without zoom/pan

- [ ] **Scenario: large diagram supports zoom, pan, fit, and reset**
  - **Given** a Mermaid block wider/taller than the viewport (e.g. a multi-subgraph flowchart)
  - **When** the user zooms in, pans by drag, uses fit-to-view, and resets to 100%
  - **Then** the diagram remains navigable without irrecoverable clipping
  - **And** fit/reset restore a predictable framing

- [ ] **Scenario: Activity scroll is preserved**
  - **Given** a Mermaid diagram is visible in the Activity feed
  - **When** the user scrolls with the wheel/trackpad outside the diagram viewport, or at pan limits / unzoomed state per the gesture policy
  - **Then** the Activity feed scrolls normally
  - **And** the diagram does not permanently capture wheel events in a way that traps the user

- [ ] **Scenario: keyboard and focus affordances**
  - **Given** the diagram viewport (or its control chrome) can receive focus
  - **When** the user uses the documented keyboard shortcuts (zoom / reset / pan or equivalent accessible controls)
  - **Then** navigation works without requiring a mouse
  - **And** focus rings / control labels remain usable

- [ ] **Scenario: Source remains byte-for-byte original**
  - **Given** a rendered Mermaid block
  - **When** the user toggles Source
  - **Then** the displayed source matches the original fenced content byte-for-byte
  - **And** zoom/pan state does not rewrite or re-serialize the Mermaid source

- [ ] **Scenario: hostile Mermaid stays fail-closed**
  - **Given** Mermaid content that attempts scripts, click handlers, or mutating links
  - **When** it is rendered under existing `securityLevel: "strict"` and Activity CSP
  - **Then** the diagram gains no write capability, no executable script from diagram content, and no mutation of the message/file/handoff
  - **And** navigation chrome is first-party only (not driven by diagram markup)

- [ ] **Scenario: visual QA across theme and width**
  - **Given** light and dark code themes and narrow vs wide Activity viewports
  - **When** a representative diagram is navigated (zoom/pan/fit/reset)
  - **Then** controls remain readable, contrast is acceptable, and layout does not collapse or overflow the feed card

- [ ] Zoom controls include accessible buttons (not wheel-only).
- [ ] A current scale indicator is visible while the diagram view is active (e.g. `100%`, `150%`).
- [ ] Zoom/pan state is ephemeral and local to the live diagram view (not persisted across sessions, messages, or Source↔Diagram toggles unless intentionally re-derived on remount).
- [ ] Interaction is confined to the diagram viewport; it does not block general Activity navigation (search, jump-to-latest, message actions).

## Non-goals

- Mermaid editor / live re-render from edited source
- Persisted layout, saved zoom, or per-message view state
- Export (PNG/SVG download), print, or collaboration cursors
- Changing Mermaid grammar, themes beyond existing light/dark, or the on-demand load pipeline
- Replacing `securityLevel: "strict"`, CSP, or introducing `eval`/inline handlers from diagram content
- Fullscreen lightbox (image lightbox is a separate pattern; this stays inline)
- Non-Mermaid diagram languages
- Changing Handoff content model or Bridge protocols

## Open questions

_Resolved during research (defaults for implementation; ratify in plan):_

1. **Gesture policy for plain wheel** — **Default:** plain wheel never zooms; `Ctrl`/`Cmd`+wheel (and pinch where available) zoom; at `scale === 1` plain wheel always passes to Activity; when zoomed, optional vertical pan with pass-through at edges. Buttons always available. (Ratify if product wants hover-to-capture wheel instead.)
2. **Shared component vs Activity-only** — **Default:** implement on shared `MermaidBlock` so Handoff benefits; no Activity-only fork.
3. **What is 100%** — **Default:** `100%` = natural SVG pixel size (pre-CSS shrink); initial open uses fit-to-width behavior equivalent to today's `max-width: 100%` so small diagrams stay natural and large ones open fitted.
