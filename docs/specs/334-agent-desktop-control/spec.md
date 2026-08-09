# 334 — agent-desktop-control

_Created 2026-07-02._

**Status:** shipped

**Closure:** Shipped `agent-desktop` v0.1.0 in `/home/goat/tachyon-plugins`: Windows-host/WSL desktop control
primitives for `doctor`, `list-windows`, `launch`, `open-url`, `wait-window`, `focus`, and `restore`, with JSON output,
stable exit codes, Chrome URL opening, explicit ambiguity/timeout/invalid-argument failures, and visual dogfood via
`agent-screen`.

**Verify:** `bash -n /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh`
**Dogfood:** `bash -lc 'set -euo pipefail; evidence=.tachyon/evidence/agent-desktop-v1-dogfood-final; mkdir -p "$evidence"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh open-url --browser chrome --new-window https://example.com --json > "$evidence/open-url.json"; window_id=$(node -e "const fs=require(\"fs\"); const j=JSON.parse(fs.readFileSync(process.argv[1], \"utf8\")); if (!j.ok || !j.window_id) process.exit(1); console.log(j.window_id)" "$evidence/open-url.json"); /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh focus --window-id "$window_id" --json > "$evidence/focus.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh restore --window-id "$window_id" --json > "$evidence/restore.json"; /home/goat/tachyon-plugins/agent-screen/skills/agent-screen/scripts/agent-screen.sh screenshot --window-id "$window_id" --out "$evidence/chrome.png" > "$evidence/screenshot.txt"; test -s "$evidence/chrome.png"'`

## Intent

Agents now have `agent-screen` as explicit desktop "eyes": they can inspect real native/VS Code/browser surfaces after
the user consents to screen inspection. The next gap is "hands": before taking a screenshot, an agent often needs to
open an app, bring an existing app window forward, restore a minimized window, wait for the target window to exist, or
open a URL in a browser. Today that is possible only through ad-hoc shell/PowerShell commands with no stable CLI contract,
no structured output, and no clear consent boundary.

`agent-desktop` should be a new plugin, shaped like `agent-screen`, that provides explicit local desktop-control
primitives. V1 is conservative: app/window presence, focus, restore, launch, wait, and URL opening. It deliberately does
not introduce arbitrary mouse/keyboard automation yet. The user gives consent for the agent to mutate desktop state; for
this first version we do not block on privacy detection/redaction.

## Acceptance criteria

- [x] **Scenario: inspect a browser page from a cold or hidden app**
  - **Given** the user has consented to desktop control and wants the agent to inspect a URL in Chrome.
  - **When** the agent runs `agent-desktop open-url --browser chrome --new-window <https-url>` and then captures via
    `agent-screen`.
  - **Then** Chrome is launched in a deterministic new window, a matching Chrome window is available/focused/restored,
    stdout includes a `window_id`, and `agent-screen screenshot --window-id <id>` can produce visual evidence without
    relying on `agent-screen --restore-minimized`.
- [x] **Scenario: focus an existing native app**
  - **Given** a target process/window already exists.
  - **When** the agent runs `agent-desktop focus --window-id <id>` or `agent-desktop focus --process <name>`.
  - **Then** the target top-level window is foregrounded/restored and stdout reports the selected id, process, and bounds.
- [x] **Scenario: focus denial is explicit**
  - **Given** Windows refuses to foreground the target because of foreground-lock or elevation restrictions.
  - **When** the agent runs `agent-desktop focus ...`.
  - **Then** the command fails with a machine-readable `focus-denied` error instead of reporting fake success.
- [x] **Scenario: wait for a launched app**
  - **Given** the agent launches an app whose window may appear asynchronously.
  - **When** the agent runs `agent-desktop wait-window --process <name> --title <substring> --timeout <seconds>`.
  - **Then** the command exits zero with a matching window before the timeout, or fails closed with no fake success.
- [x] **Scenario: ambiguity is explicit**
  - **Given** multiple windows match a process/query.
  - **When** the agent runs a command that requires one target but does not pass `--window-id`.
  - **Then** the command fails closed and returns bounded candidate metadata so the agent can retry with an id.
- [x] **Scenario: state change is explicit**
  - **Given** a command may open, focus, restore, or foreground an app/window.
  - **When** it succeeds.
  - **Then** stdout reports the state changes performed, such as `launched=true`, `focused=true`, `restored=true`.
- [x] `agent-desktop` is a separate plugin from `agent-screen`; screen capture remains in `agent-screen`.
- [x] V1 supports Windows-host control from WSL, matching the current primary dogfood environment.
- [x] V1 command output is JSON-capable for every command, with stable exit codes for ok, timeout, not-found, ambiguous,
  focus-denied, and invalid-argument failures.
- [x] V1 window bounds use the same physical-pixel coordinate convention as `agent-screen`.
- [x] V1 documentation states that user consent permits desktop mutation and that privacy/redaction is future work.

## Non-goals

- No arbitrary mouse movement/clicking in v1.
- No arbitrary keyboard typing/hotkeys in v1.
- No OCR, visual recognition, or screenshot capture; use `agent-screen`.
- No automatic privacy detection, blur, or redaction in v1.
- No background automation loops.
- No hidden persistence, hooks, or autonomous app control outside an explicit command.
- No macOS/Linux-native desktop backend unless it falls out cheaply; Windows-host from WSL is the first target.
- No composite `ensure` command in v1; agents can compose launch/open-url, wait-window, restore, focus, and
  `agent-screen` explicitly.

## Open questions

- Should v1.1 include `move`/`resize` layout commands now that launch/focus/restore is proven?
