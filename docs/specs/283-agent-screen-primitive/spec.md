# 283 — agent-screen-primitive

_Created 2026-06-28._

**Status:** deferred
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

**Deferral:** deferred 2026-06-28 until a real use case appears (owner decision). NOT abandoned — the design below is
captured so it isn't re-derived when demand lands; a Tachyon **pin** tracks the revisit. Build is gated on rule-of-three
demand (the speculative-observability discipline carried over from Agent0): a concrete consumer (or Tachyon surface)
that needs Visual QA on a NON-web surface. Today every Tachyon surface is a webview already covered by `agent-browser` +
the visual-qa family (specs 274/275/277/281), so agent-screen serves only a hypothetical native/desktop/TUI/mobile
consumer — none observed yet.

## Intent

The visual-qa family (274 producer, 275 skill, 277 interactive, 281 discovery) gives agents **eyes on web surfaces** via
`agent-browser` — a real URL, a headless Chrome, a screenshot + DOM. Specs 274/275/277 each explicitly deferred
**native / desktop / mobile / TUI** Visual QA to "the future `agent-screen` primitive": an OS-level capture (window
screenshot + optional accessibility tree) for projects with **no browser route**. agent-screen would be the runtime-
neutral sibling of `agent-browser` (same shape: a shell tool, fail-closed when its capture backend is absent), feeding
the same visual-qa consumer a screenshot + a11y snapshot from a native window instead of a DOM page.

"Done" (when built) looks like: an agent can capture a named native window (or the active app) to a PNG + an optional
structured a11y tree, on the dev's OS, fail-closed with a clear reason when the OS backend or a display is unavailable —
and the visual-qa skill can consume that capture exactly as it consumes an `agent-browser` screenshot today.

**Why deferred, not built:** see the Deferral note. The honest blockers are demand (no observed consumer) + cost
(below) — not feasibility doubt.

## Acceptance criteria

_Deferred — these are the BUILD gates to satisfy if/when a real use case promotes this spec. Not tickable today._

- [ ] A concrete use case exists: a named consumer (or Tachyon surface) that needs Visual QA on a non-web surface, with
      the OS + surface type stated. (The rule-of-three demand gate — this unblocks everything below.)
- [ ] **Scenario: capture a native window**
  - **Given** a running native app window on the dev's OS
  - **When** the agent runs `agent-screen capture --window <title|active> --out <png>`
  - **Then** a PNG of that window is written, or a fail-closed error names the missing backend/display (never a blank/fake image)
- [ ] **Scenario: degrade-closed with no display**
  - **Given** a headless host (no X11/Wayland/WindowServer) or WSL2 without WSLg
  - **When** capture is attempted
  - **Then** it exits non-zero with `agent-screen: no capture backend (<reason>)` — never a silent empty file
- [ ] the visual-qa skill consumes an agent-screen capture through the same path it uses for an agent-browser screenshot
- [ ] scope is honest: a single supported platform for v1 (degrade-closed elsewhere), NOT a half-working cross-OS matrix

## Non-goals

- Building anything before a real use case lands (the whole point of the deferral).
- A full cross-platform matrix in one shot — capture is per-OS (macOS `screencapture`/AXUIElement, Windows
  .NET/UIAutomation, Linux X11 `scrot`/`maim` **vs** Wayland `grim` **vs** AT-SPI, mobile `adb`/`xcrun simctl`); v1 must
  pick ONE platform and degrade-closed, like `unused-code`'s per-stack engines but harder (display servers, permissions).
- Pixel-diff regression gating, OCR, baseline-management UX (the visual-qa family already ruled these out).
- Replacing `agent-browser` for web surfaces — agent-screen is strictly the non-web complement.

## Open questions

_To resolve at promotion time, not now._

- **Which platform for v1?** Most Tachyon devs are likely on macOS (`screencapture` is built-in, no extra binary) — the
  probable first target. Confirm against the actual consumer's OS when demand lands.
- **a11y tree in v1, or pixels-only first?** The a11y tree (AXUIElement / UIAutomation / AT-SPI) is the semantic value
  but a per-OS surface of its own; pixels-only may be a sufficient v1.
- **WSL2 story.** The current dev env (WSL2, no WSLg) cannot capture a native desktop — a weak dogfood corpus. Does the
  consumer run a real desktop OS, or do we need a remote/host-bridge capture path?
- **Window targeting.** By title? by active? by app bundle id / process? — OS-dependent; defer to the consumer's need.

## Context / references

- `agent-browser` primitive — the web sibling whose shape (runtime-neutral shell tool, fail-closed, no MCP fallback)
  agent-screen should mirror.
- Deferring specs: 274 § Non-goals (~line 114), 275 § (native/desktop → future agent-screen), 277 § Non-goals (~line
  169) — all three name this primitive as the future home for non-web Visual QA.
- visual-qa family: specs 274 (producer), 275 (skill), 277 (interactive), 281 (discovery) — the consumer agent-screen
  would feed.
- Precedent for "design captured, build demand-gated": Agent0's `/complexity` deferral (pre-chewed design, revisit on
  rule-of-three demand).
