# 340 — agent-desktop-input-control

_Created 2026-07-03._

**Status:** draft

## Intent

`agent-desktop` can now find apps, open them, focus windows, restore minimized state, and clean up what it owns. Together
with `agent-screen`, that gives the agent eyes plus basic setup/cleanup. The missing piece is controlled input inside the
focused native window: typing text, pressing keys, and clicking a specific coordinate after a screenshot has shown what
is on screen.

This spec adds the first "hands inside the window" primitives. The commands must be explicit, session-aware, and tied to
a target window identity. The plugin should not become a background robot or a free-form macro runner. It should provide
small, inspectable operations that an agent can chain with `agent-screen`: focus a known window, capture screenshot, type
or press a key, capture again, and cleanup/restore touched windows when appropriate.

## Acceptance criteria

- [ ] **Scenario: type text into a focused owned window**
  - **Given** a window launched by `agent-desktop launch --wait-window --session <id>`.
  - **When** the agent runs `agent-desktop type --window-id <id> --text <text> --session <id> --json`.
  - **Then** the plugin focuses the window, verifies the foreground window immediately before injection, sends the text
    as literal Unicode input, and returns JSON with the target identity, typed character count, and post-input foreground
    identity.
- [ ] **Scenario: unsafe text transport is avoided**
  - **Given** text crosses bash, WSL interop argv, and PowerShell parameter binding.
  - **When** the agent runs `agent-desktop type`.
  - **Then** the shell wrapper transports text as base64-encoded UTF-8 into a fixed PowerShell parameter, the PowerShell
    side decodes it as data, `SendInput` with `KEYEVENTF_UNICODE` is used for injection, and `SendKeys` is not used for
    literal text.
- [ ] **Scenario: multiline/control text is refused**
  - **Given** `--text` contains `\n`, `\r`, other control characters, or more than 1024 characters.
  - **When** `agent-desktop type` runs.
  - **Then** the command returns `invalid-argument` and sends no keyboard event; new lines must use explicit
    `agent-desktop key --key enter`.
- [ ] **Scenario: press a safe key or key chord**
  - **Given** a visible target window selected by `--window-id`.
  - **When** the agent runs `agent-desktop key --window-id <id> --key ctrl+s --session <id> --json`.
  - **Then** the plugin focuses the window, sends only a whitelisted key/chord, releases any synthetic modifiers on every
    path, and reports the chord it sent.
- [ ] **Scenario: click within a target window**
  - **Given** `agent-screen screenshot --window-id <id>` produced a screenshot with known window bounds.
  - **When** the agent runs `agent-desktop click --window-id <id> --x <px> --y <px> --session <id> --json`.
  - **Then** the plugin treats `--x/--y` as screenshot-relative offsets into the DWM extended frame bounds, computes the
    screen point as `bounds.x + x`, `bounds.y + y`, refuses out-of-bounds coordinates, focuses the window, clicks once
    with a left button down/up pair, and reports the absolute coordinate used.
- [ ] **Scenario: nonclient clicks are refused**
  - **Given** the requested point lands on the title bar, resize border, system menu, minimize, maximize, or close button.
  - **When** `agent-desktop click` runs.
  - **Then** the command returns `invalid-argument` and sends no mouse event.
- [ ] **Scenario: obscured clicks are refused**
  - **Given** the requested point is inside the target bounds but another root window, overlay, popup, or dialog is
    topmost at that point.
  - **When** `agent-desktop click` runs.
  - **Then** the plugin verifies `WindowFromPoint(screenPoint)` resolves to the target root immediately before the click,
    otherwise returns `focus-denied` and sends no mouse event.
- [ ] **Scenario: moved or resized target invalidates a click**
  - **Given** the target window bounds changed between the screenshot and click command.
  - **When** `agent-desktop click` runs with an expected bounds token or expected bounds fields from the screenshot.
  - **Then** the plugin re-fetches current bounds and refuses the click if they differ.
- [ ] **Scenario: dry-run before mutation**
  - **Given** an input command would mutate the desktop.
  - **When** the command includes `--dry-run`.
  - **Then** stdout reports the target window and planned input without typing, pressing, or clicking.
- [ ] **Scenario: session is mandatory for every input**
  - **Given** an input command is invoked without `--session`.
  - **When** `agent-desktop type`, `agent-desktop key`, or `agent-desktop click` runs.
  - **Then** the command returns `invalid-argument` and sends no input.
- [ ] **Scenario: touched user window returns to prior visibility**
  - **Given** the target window was not owned by the session and was minimized before input.
  - **When** an input command restores/focuses it and `cleanup --session <id>` later runs.
  - **Then** cleanup does not close the window and restores the recorded minimized state.
- [ ] **Scenario: stale or mismatched target is refused**
  - **Given** a window id was reused, closed, or now belongs to a different process/start time/class.
  - **When** an input command targets it through a session ledger record.
  - **Then** the command fails closed and does not send input.
- [ ] **Scenario: out-of-bounds click is refused**
  - **Given** the requested coordinate is outside the target window DWM extended frame bounds.
  - **When** `agent-desktop click` runs.
  - **Then** the command returns `invalid-argument` and sends no mouse event.
- [ ] **Scenario: unsupported keys are refused**
  - **Given** the requested key/chord is not in the documented allow-list.
  - **When** `agent-desktop key` runs.
  - **Then** the command returns `invalid-argument` and sends no keyboard event.
- [ ] **Scenario: dirty owned windows are not force-killed**
  - **Given** an owned app window was made dirty by input and refuses `WM_CLOSE` with a save prompt.
  - **When** `cleanup --session <id>` runs.
  - **Then** cleanup reports `still_open`, does not kill the process, and leaves the app's own prompt for the user or
    caller to handle. Dogfood must avoid this state or explicitly assert it.
- [ ] **Scenario: agent-screen pairing is documented**
  - **Given** an agent needs to manipulate a native UI.
  - **When** it follows the docs.
  - **Then** the expected loop is: `agent-desktop` focus/open -> `agent-screen` screenshot -> `agent-desktop` input ->
    `agent-screen` screenshot -> cleanup.
- [ ] Input actions append a ledger event recording command type, target identity, timestamp, and dry-run/mutation result.
- [ ] Text input is passed as data to a fixed PowerShell script, not interpolated into executable shell code.
- [ ] Input commands require explicit `--window-id` and explicit `--session`; process/title fuzzy targeting is not accepted
  for mutation in v1.
- [ ] Key allow-list is exactly: `enter`, `escape`, `tab`, `backspace`, `delete`, `up`, `down`, `left`, `right`,
  `ctrl+a`, `ctrl+f`, `ctrl+s`, `ctrl+z`. `ctrl+c`/`ctrl+v`, `alt+f4`, and arbitrary function keys are excluded in v1.
- [ ] `ctrl+s` is allowed because the user consented to desktop mutation, but docs must state it can persist user data in
  non-owned apps.
- [ ] Click is a single left click only. No right click, double click, drag, scroll, or cursor restoration is promised in
  v1; the physical cursor may move.
- [ ] Mouse movement without click, drag-and-drop, scroll wheels, clipboard writes, file uploads, screen recording, OCR,
  and background automation loops are not part of this spec.
- [ ] JSON stdout remains the only output format and existing exit codes remain stable: bad key, bad text, out-of-bounds,
  and nonclient clicks return code 64 `invalid-argument`; foreground lost or obscured target returns code 74
  `focus-denied`; stale or mismatched ledger identity uses the existing 71/72 target-state failures.

## Non-goals

- No computer-use planner or autonomous UI agent inside the plugin.
- No OCR or image understanding; use `agent-screen` plus the calling model.
- No drag-and-drop, scroll, text selection, clipboard, multi-click macros, or arbitrary shell hooks.
- No global clicks by screen coordinate without a target window.
- No interaction with elevated/UAC prompts.
- No privacy redaction; user consent covers visible desktop mutation for v1.
- No guarantee that every app accepts synthetic input.
- No guarantee that elevated apps, games, RDP sessions, or apps that reject synthetic input will mutate; callers must use
  JSON plus `agent-screen` proof after input.

## Open questions

- None. Claude Fable ad-hoc review `claude-fable-340-spec-review` resolved v1 scope: single-line text only,
  screenshot/DWM-bounds-relative click coordinates, mandatory session, and the narrow key allow-list above.
