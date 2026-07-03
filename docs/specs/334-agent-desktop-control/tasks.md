# 334 — agent-desktop-control — tasks

_Generated from `plan.md` on 2026-07-02._

## Planning

- [x] Record the `agent-desktop` direction: desktop "hands" paired with `agent-screen` desktop "eyes".
- [x] Keep arbitrary keyboard/mouse automation out of v1.
- [x] Record consent posture: user consent permits explicit desktop mutation; privacy filtering is future work.
- [x] Fold Claude Fable probe feedback into the plan.
- [x] Cut composite `ensure` from v1.
- [x] Require deterministic `open-url`/`wait-window` matching beyond process name alone.

## Implementation

- [x] Spike Windows foreground/focus feasibility from WSL PowerShell.
- [x] Decide and document the Windows foreground workaround/failure mode.
- [x] Scaffold `agent-desktop` plugin in `/home/goat/tachyon-plugins`.
- [x] Implement `agent-desktop doctor`.
- [x] Implement `agent-desktop list-windows --json [--verbose]`.
- [x] Implement `agent-desktop launch --app <name-or-path>`.
- [x] Implement `agent-desktop open-url --browser chrome [--new-window] <https-url>`.
- [x] Implement `agent-desktop wait-window --process <name> [--title <substring>] --timeout <seconds>`.
- [x] Implement `agent-desktop focus --window-id <id>` and `focus --process <name>`.
- [x] Implement `agent-desktop restore --window-id <id>`.
- [x] Implement JSON-capable output and documented exit codes for every command.
- [x] Restrict `open-url` v1 to `http://` and `https://` URLs.
- [x] Document consent, state mutation, and pairing with `agent-screen`.

## Verification

- [x] Smoke `agent-desktop doctor`.
- [x] Smoke `list-windows --json` and validate JSON shape.
- [x] Smoke `launch --app chrome` or `open-url --browser chrome --new-window <url>`.
- [x] Smoke `wait-window --process chrome --title <substring> --timeout 10`.
- [x] Smoke `focus --window-id <id>`.
- [x] Smoke ambiguity failure for process/query matching.
- [x] Smoke focus-denied failure if Windows refuses foregrounding.
- [x] Verify command output includes selected id/process/bounds and state flags.

**Verify:** `bash -n /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh`

## Dogfood

**Dogfood:** `bash -lc 'set -euo pipefail; evidence=.tachyon/evidence/agent-desktop-v1-dogfood-final; mkdir -p "$evidence"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh open-url --browser chrome --new-window https://example.com --json > "$evidence/open-url.json"; window_id=$(node -e "const fs=require(\"fs\"); const j=JSON.parse(fs.readFileSync(process.argv[1], \"utf8\")); if (!j.ok || !j.window_id) process.exit(1); console.log(j.window_id)" "$evidence/open-url.json"); /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh focus --window-id "$window_id" --json > "$evidence/focus.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh restore --window-id "$window_id" --json > "$evidence/restore.json"; /home/goat/tachyon-plugins/agent-screen/skills/agent-screen/scripts/agent-screen.sh screenshot --window-id "$window_id" --out "$evidence/chrome.png" > "$evidence/screenshot.txt"; test -s "$evidence/chrome.png"'`

**Human dogfood:** Use the installed plugin to open/focus Chrome or VS Code, then use installed `agent-screen` to capture
the resulting window.

## Visual QA

- [x] Evidence: `.tachyon/evidence/agent-desktop-v1-dogfood-final/chrome.png`
- [x] Verdict: pass — `agent-desktop` opened a new Chrome window, returned its `window_id`, focused/restored that id,
  and `agent-screen` captured the same window without `--restore-minimized`.

## Future Backlog

- Add layout commands: move, resize, arrange left/right.
- Add composite `ensure` once primitive command semantics are stable.
- Add explicit keyboard primitives: hotkey, type.
- Add explicit mouse primitives: click, move, scroll.
- Add optional restore-after/minimize-after cleanup semantics.
- Add privacy-aware warnings/redaction once basic control is proven useful.
