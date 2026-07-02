# 283 - agent-screen-primitive

_Created 2026-06-28. Promoted 2026-07-02._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

**Promotion:** promoted 2026-07-02 because a real consumer exists now: installed Tachyon/VS Code dogfood. Spec 330 proved
the Bridge can validate agent state and postmortem affordances, but an agent still cannot inspect the real VS Code
sidebar chrome on the developer's desktop. A browser/headless preview is not a substitute for the installed extension.

## Intent

Build `agent-screen` as a runtime-neutral plugin primitive that gives agents explicit, bounded eyes on non-web surfaces.
The v1 target is intentionally narrow: capture a real desktop screenshot for dogfood and Visual QA evidence when the
surface is VS Code, a native app, a TUI/terminal window, or another UI with no browser route.

`agent-screen` should mirror the shape of `agent-browser`: shell-first, deterministic artifacts, fail-closed when the
host cannot capture a screen, and no fake/blank success path. The primitive feeds the same evidence/visual-qa lane as
web screenshots, but its capture source is the OS display instead of a DOM page.

Done for v1 means an agent can run `agent-screen doctor`, list candidate windows when the platform supports it, and
write a nonblank PNG from either the active window/screen or a selected window. If capture is unavailable, the command
exits non-zero with a clear reason naming the missing display/backend/permission.

## Acceptance criteria

- [ ] **Demand gate is satisfied:** the named consumer is Tachyon dogfood of installed VS Code surfaces, starting with
      the sidebar/agent rows where Bridge data cannot prove visual affordances.
- [ ] **Scenario: doctor explains capability**
  - **Given** a host with or without a usable display capture backend
  - **When** the agent runs `agent-screen doctor`
  - **Then** it reports the selected backend and supported commands, or exits non-zero with a clear unavailable reason.
- [ ] **Scenario: screenshot the active surface**
  - **Given** a running desktop session with the Tachyon/VS Code window visible or active
  - **When** the agent runs `agent-screen screenshot --active --out <png>`
  - **Then** a bounded PNG is written and is not blank, or the command fails closed before writing a misleading artifact.
- [ ] **Scenario: screenshot a selected window**
  - **Given** a backend that supports window enumeration/targeting
  - **When** the agent runs `agent-screen list-windows` and then `agent-screen screenshot --window <query> --out <png>`
  - **Then** the chosen window is captured, or an ambiguous/missing match is reported without capture.
- [ ] The visual-qa/evidence workflow can consume an `agent-screen` PNG through the same durable artifact path used by
      existing browser screenshots.
- [ ] Capture is explicit and user-auditable: no continuous background recording, no automatic screenshot on unrelated
      commands, and no silent upload.
- [ ] Scope is honest: one supported platform/backend for v1, with degrade-closed behavior everywhere else.

## Non-goals

- Screen recording in v1. Recording is the v2 direction below, after screenshot capture proves the primitive.
- Full cross-platform parity in one pass. Capture is per-OS and permission-sensitive.
- OCR, pixel-diff baselines, regression gates, or baseline-management UX.
- Accessibility tree capture in v1 unless it falls out cheaply from the chosen platform. Pixels unblock the current
  dogfood gap; semantic trees can follow.
- Replacing `agent-browser` for web surfaces.

## V1 Direction

Implement as a plugin, not core. The initial backend should fit the observed dogfood host first and degrade elsewhere.
On the current host, the available pieces are WSL2/WSLg-style display variables plus `ffmpeg` and `xdotool`; common
Linux screenshot tools (`grim`, `scrot`, `maim`, `gnome-screenshot`, ImageMagick `import`, `swaymsg`) are absent. That
points to an `ffmpeg`-based capture path plus `xdotool` for active window/window metadata as the first candidate, with
the final backend confirmed during implementation.

Proposed CLI:

- `agent-screen doctor`
- `agent-screen list-windows`
- `agent-screen screenshot --active --out <png>`
- `agent-screen screenshot --window <query> --out <png>`

## V2 Direction

Add explicit, bounded screen recording once screenshot v1 is proven:

- `agent-screen record --active --duration <seconds> --out <mp4|webm>`
- optional `--window <query>` and `--fps <n>` where the backend supports it
- hard duration and file-size caps
- visible command status in logs/stdout, with clear cleanup on cancel/timeout
- no background daemon and no implicit recording from other tools
- artifact metadata suitable for evidence attachments and postmortem debugging

V2 recording is for short dogfood clips: animation, hover/focus behavior, transient sidebar states, and "what happened
right before/after" UX bugs that a still screenshot cannot show. It is not a surveillance or session-replay feature.

## Open questions

- Which exact v1 backend is most reliable under the current WSLg/Linux setup: `ffmpeg` x11grab, Wayland-compatible
  capture, or a host-side bridge?
- Should v1 capture the full screen first and crop/window-target later, or require active-window capture before shipping?
- Where should evidence land by default: visual-qa's existing evidence channel, a plugin-local `.tachyon/evidence`
  directory, or both?
- What is the minimal privacy affordance in the Tachyon UI when an agent requests screen capture?

## Context / references

- `agent-browser` primitive: the web sibling whose shape `agent-screen` should mirror.
- visual-qa family: specs 274 (producer), 275 (skill), 277 (interactive), 281 (discovery).
- spec 330 postmortem dogfood: exposed the current production-validation gap for installed VS Code UI.
