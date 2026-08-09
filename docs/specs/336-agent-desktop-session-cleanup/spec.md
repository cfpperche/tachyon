# 336 — agent-desktop-session-cleanup

_Created 2026-07-03._

**Status:** shipped

**Closure:** Shipped `agent-desktop` v0.1.1 session cleanup for Chrome `open-url`: dedicated session profiles,
**Verify:** `bash -n /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh`
**Dogfood:** `bash -lc 'set -euo pipefail; evidence=.tachyon/evidence/agent-desktop-cleanup-v11; mkdir -p "$evidence"; session="dogfood-336-$(date +%s)"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh open-url --browser chrome --new-window https://example.com --session "$session" --json > "$evidence/open-1.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh open-url --browser chrome --new-window https://www.iana.org/domains/reserved --session "$session" --json > "$evidence/open-2.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh cleanup --session "$session" --dry-run --json > "$evidence/dry-run.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh cleanup --session "$session" --json > "$evidence/cleanup.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh sessions show --session "$session" --json > "$evidence/session-after.json"; node -e "const fs=require(\"fs\"); const c=JSON.parse(fs.readFileSync(process.argv[1], \"utf8\")); if (!c.ok || !c.closed || c.closed.length < 2) process.exit(1)" "$evidence/cleanup.json"'`
workspace JSON ledger, `sessions list/show`, `cleanup --dry-run`, `cleanup --session`, `cleanup --mine`, conservative
`close --window-id`, identity revalidation before close, and runtime requirement preflight in `doctor`. Generic `launch`
ownership is intentionally not claimed unless a future implementation can prove process/window identity safely.

## Intent

`agent-desktop` v0.1.0 can open, focus, restore, and capture-ready desktop windows, but it leaves a bad dogfood
experience: every `open-url` or `launch` that creates a new window can leave that window behind after the agent is done.
The first overnight dogfood created multiple Chrome windows and required the user to clean them up manually.

V1.1 should add explicit ownership and cleanup semantics. When the plugin opens something it can safely own, it should
record that the window belongs to a plugin session, expose that ownership in JSON output, and provide conservative
cleanup commands that close only windows the plugin opened. Windows that preexisted and were only focused/restored must
not be closed.

The safety bar is high because cleanup is destructive. A bare HWND/window id is not enough: Windows can reuse HWNDs, and
Chrome may route a new URL through an existing browser process. For Chrome URL opening, v1.1 should use a dedicated
session browser profile (`--user-data-dir`) so plugin-owned Chrome windows are process/profile isolated from the user's
normal Chrome windows. Cleanup must still revalidate window identity immediately before closing. The same pass should
improve docs/install DX by stating environment requirements that are not Tachyon-managed `externalTools`: WSL, Windows
host PowerShell, `wslpath`, and Chrome for Chrome URL opening.

## Acceptance criteria

- [x] **Scenario: owned URL window is cleaned up**
  - **Given** the user consents to desktop control and the agent opens a Chrome URL with `agent-desktop open-url`.
  - **When** the command succeeds.
  - **Then** Chrome is launched with a dedicated session `--user-data-dir`.
  - **And** stdout includes `session_id`, `owned=true`, `window_id`, `pid`, process start time, window class, profile
    path, and enough ledger metadata to later clean the window without matching by title.
  - **And** `agent-desktop cleanup --session <session_id>` closes the window opened by that session.
- [x] **Scenario: multiple owned windows in one session are cleaned up together**
  - **Given** an agent opens two Chrome URLs under the same session.
  - **When** the agent runs `agent-desktop cleanup --session <session_id>`.
  - **Then** both owned windows are closed, cleanup JSON lists each attempted close, and no matching owned window remains.
- [x] **Scenario: preexisting windows are not closed**
  - **Given** a Chrome or VS Code window existed before the session started.
  - **When** the agent focuses or restores that preexisting window, then runs cleanup for the session.
  - **Then** cleanup does not close the preexisting window, and the ledger marks it as `owned=false` / `touched=true`.
- [x] **Scenario: explicit close by id is conservative**
  - **Given** a ledger record says a specific `window_id` was opened by `agent-desktop`.
  - **When** the agent runs `agent-desktop close --window-id <id>`.
  - **Then** the command revalidates HWND, pid, process start time, process name, window class, and session profile
    before sending close.
  - **And** the command closes that window and updates the ledger only if identity verification passes.
  - **And** if the id is unknown, not owned, stale, or mismatched, the command fails/skips closed unless a future force
    flag is introduced.
- [x] **Scenario: cleanup is idempotent**
  - **Given** a session has already been cleaned up or a window was manually closed.
  - **When** cleanup is run again.
  - **Then** it exits zero or a clearly documented partial status, reports `already_closed` for missing owned windows, and
    does not attempt to close unrelated replacement windows that reused titles.
- [x] **Scenario: handle reuse does not close a decoy**
  - **Given** an owned window was closed manually and a new decoy user window appears before cleanup.
  - **When** the agent runs cleanup for the original session.
  - **Then** cleanup detects stale/mismatched identity and does not send close to the decoy window.
- [x] **Scenario: cleanup survives a new process invocation**
  - **Given** `open-url` was run in one shell process and `cleanup --session <id>` is run later in another shell process.
  - **When** cleanup runs.
  - **Then** it reads the persisted ledger and can close the owned windows without relying on in-memory state.
- [x] **Scenario: requirements are clear at install/use time**
  - **Given** the Tachyon install modal shows no installable dependencies.
  - **When** the user reads `agent-desktop` docs or runs `doctor`.
  - **Then** it is clear that WSL, Windows host PowerShell, `wslpath`, and Chrome for `open-url --browser chrome` are
    environment requirements rather than Tachyon-provisioned `externalTools`.
- [x] **Scenario: dry-run/audit before destructive cleanup**
  - **Given** a session ledger contains owned windows.
  - **When** the agent runs `agent-desktop cleanup --session <id> --dry-run`.
  - **Then** stdout lists exactly which windows would be closed, each live identity verification status, and no window is
    closed.
- [x] **Scenario: stale/corrupt ledger is recoverable**
  - **Given** a ledger is stale after reboot, unreadable, or corrupt.
  - **When** the agent runs session listing or cleanup.
  - **Then** the command never closes windows based on that ledger, reports a structured warning/error, and preserves or
    quarantines the bad ledger for inspection.
- [x] **Scenario: preflight is actionable**
  - **Given** WSL interop, PowerShell, `wslpath`, or Chrome is unavailable.
  - **When** the agent runs `doctor` or a command that needs that dependency.
  - **Then** JSON output names the missing requirement and points to the docs instead of failing with an opaque shell or
    PowerShell error.
- [x] V1.1 retains v0.1.0 safety boundaries: no arbitrary keyboard, mouse, screenshots, privacy redaction, background
  loops, or hidden persistence outside the explicit session ledger.
- [x] The ledger path is local to the workspace, is JSON, has a schema version, and is safe to inspect/debug.
- [x] Ledger writes are atomic enough for shell usage: write temp file, rename, and avoid corrupting an existing session
  file on failure.
- [x] Cleanup output has per-window result states: `closed`, `already_closed`, `still_open`, `stale`, `mismatched`, and
  `not_owned`.
- [x] Cleanup never uses title-only matching and never interpolates window titles into PowerShell command strings.
- [x] Session cleanup dogfood must prove there are no plugin-opened Chrome windows left behind.

## Non-goals

- No broad background daemon. A bounded `--cleanup-on-exit` wrapper/trap may be added only if explicit and documented.
- No closing windows the plugin did not open.
- No process tree killing by default. Process termination is allowed only with an explicit future flag and only when the
  process/profile is proven exclusive to the session.
- No layout/move/resize commands.
- No keyboard/mouse primitives.
- No privacy detection/redaction.
- No Tachyon installer support for non-installable environment requirements beyond docs/manifest text that current UI can
  surface.

## Open questions

- Should `cleanup --session <id>` close windows with `WM_CLOSE` only, or also offer a conservative `--kill-owned-process`
  fallback when the owned process has no other visible windows?
- Should v1.1 add `--cleanup-on-exit` in the same implementation, or keep it as a documented dogfood discipline after
  explicit cleanup primitives ship?
