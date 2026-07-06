# 361 — reload-restore-panels-terminals

_Created 2026-07-06._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

After a VS Code window reload, Tachyon editor webview panels and opened tmux-backed terminal tabs disappear. VS Code discards webview panels without a registered `WebviewPanelSerializer`, and Tachyon intentionally marks terminal tabs transient so VS Code does not revive dead bash ghosts.

Done means first-party trusted Tachyon editor panels register serializers and restore from minimal identity state, while Tachyon reopens transient terminal tabs only when their tmux sessions still exist.

## Acceptance criteria

- [x] **Scenario: Trusted webview panels survive reload**
  - **Given** a first-party Tachyon editor webview panel is open with its workspace/entity identity
  - **When** VS Code reloads the window and activates the extension again
  - **Then** Tachyon registers a serializer for that view type and rehydrates the panel in place from minimal trusted state
- [x] **Scenario: Managed terminal tabs reopen after reload**
  - **Given** an agent, terminal, command, or runbook step terminal tab is open and its tmux session survives
  - **When** VS Code reloads the window and activates Tachyon
  - **Then** Tachyon reopens the transient terminal tab and reattaches it to the surviving tmux session
- [x] **Scenario: Dead terminal sessions are not restored**
  - **Given** the terminal-open manifest references a session that no longer exists in tmux
  - **When** Tachyon activates after reload
  - **Then** Tachyon prunes/skips that manifest entry without creating a ghost terminal
- [x] Plugin UI webviews are not restored by this spec.
- [x] `reloadTransaction` integration is not changed by this spec.

## Non-goals

- Restoring untrusted plugin UI surfaces. That must re-enter the broker/consent flow and regenerate handles.
- Capturing UI state inside the reload transaction.
- Letting VS Code revive Tachyon terminal tabs directly.

## Open questions

None.

**Closure:** Implemented first-party trusted webview serializers and transient terminal manifest restore for task t-5beaad Parte A+B. Verified with `npm run typecheck` and `npm test -- --run`.
