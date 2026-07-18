# 402 — pi-interaction-profile

_Created 2026-07-18._

**Status:** in-progress

## Intent

Pi is now isolated, resumable and visible in Activity, but its runtime profile still lacks measured terminal interaction semantics. Tachyon cannot distinguish an empty Pi editor from a human draft because Pi's composer is framed by two horizontal rules rather than a prompt glyph, and graceful Stop uses the generic fallback instead of Pi's documented Escape interrupt, Ctrl+C clear and Ctrl+D exit actions.

Measure the real Pi TUI in an isolated tmux server and encode its framed composer plus a profile-driven graceful-stop sequence. Attention must treat edits inside the frame as human-owned composer changes, prevent delivery into occupied drafts, recognize the ready editor without confusing unrelated output, and stop idle, drafted and active-turn Pi panes cleanly before fallback kill.

## Acceptance criteria

- [x] **Scenario: empty and occupied framed composer are distinguished**
  - **Given** real Pi pane captures with its two horizontal editor borders
  - **When** the editor is empty or contains a single/multi-line human draft
  - **Then** Tachyon reports `composerOccupied=false` or `true` respectively without depending on a prompt glyph
- [x] **Scenario: composer-only typing does not become agent output**
  - **Given** an idle Pi pane
  - **When** only text between the editor borders changes
  - **Then** Attention remains idle, tracks the occupied draft, and delivery remains protected from overwriting it
- [x] **Scenario: output outside the composer remains observable**
  - **Given** a Pi pane with a framed editor
  - **When** assistant/tool output above the top border changes
  - **Then** Attention treats it as runtime output rather than a composer-only human edit
- [x] **Scenario: launch readiness recognizes the real Pi editor**
  - **Given** Pi's framed editor plus footer
  - **When** launch readiness classifies the pane
  - **Then** it reports ready, while a project-trust selector or arbitrary horizontal rules do not satisfy the complete readiness shape
- [x] **Scenario: graceful Stop exits every measured Pi state**
  - **Given** idle, drafted and active-turn Pi panes
  - **When** Tachyon executes the Pi graceful-stop profile
  - **Then** Escape aborts an active turn, Ctrl+C clears residual editor state, Ctrl+D exits, and the process reaches clean exit without forced kill
- [x] Pi profile composer and graceful-stop sections are marked measured/verified with dated evidence and automated tmux dogfood.
- [x] Runtime parity documentation promotes Pi Attention and Graceful Stop only after Dev Host confirmation.

## Non-goals

- Pi rate-limit/provider-specific pattern discovery beyond the shared Attention patterns.
- Permission/approval injection, fork controls, configurable Pi harness resources or OAuth coordination.
- Changing Pi keybindings or writing private/global `keybindings.json`; the profile targets Pi defaults and documents that user remapping can invalidate the measured sequence.
- Redesigning composer detection for arbitrary TUIs; the additive framed-region shape serves runtimes whose editor is explicitly bounded by repeated lines.

## Open questions

- None. Pi docs define Escape=`app.interrupt`, Ctrl+C=`app.clear`, Ctrl+D=`app.exit` when the editor is empty. Live tmux measurement on Pi v0.80.10 confirmed an editor between identical horizontal borders, a reverse-video cursor on the empty line, plain draft text inside the frame, and clean exit after Escape → Ctrl+C → Ctrl+D.
