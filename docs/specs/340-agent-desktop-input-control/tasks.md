# 340 — agent-desktop-input-control — tasks

_Generated from `plan.md` on 2026-07-03. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Fold Claude Fable ad-hoc review feedback into `spec.md`/`plan.md`.
- [x] Add PowerShell input helpers for keyboard text, key chords, and mouse click.
- [x] Add explicit `--window-id` target resolution for input commands.
- [x] Require `--session` for all input commands.
- [x] Add session ledger lookup and identity verification before every input.
- [x] Add per-input ledger events for dry-run and mutating actions.
- [x] Add touched-window recording before focus for non-owned targets.
- [x] Add `type --window-id <id> --text <text> --session <id> [--dry-run]`.
- [x] Transport `type` text as base64 UTF-8 into PowerShell.
- [x] Implement literal text injection with Win32 `SendInput`, `VkKeyScanW` for printable ASCII, Unicode fallback, and no
  `SendKeys`.
- [x] Refuse multiline/control text and text longer than 1024 characters.
- [x] Add `key --window-id <id> --key <key-or-chord> --session <id> [--dry-run]`.
- [x] Define and enforce a narrow key/chord allow-list.
- [x] Release synthetic modifiers on every key path.
- [x] Add `click --window-id <id> --x <px> --y <px> --session <id> [--expected-bounds <json>] [--dry-run]`.
- [x] Treat click coordinates as screenshot/DWM-bounds-relative, not client-relative.
- [x] Re-fetch bounds immediately before click and refuse expected-bounds mismatch.
- [x] Refuse nonclient clicks.
- [x] Refuse obscured clicks via `WindowFromPoint` root-window verification.
- [x] Verify foreground target immediately before sending input.
- [x] Include post-input foreground identity in JSON for mutating input commands.
- [x] Ensure dry-run sends no keyboard or mouse input.
- [x] Return stable JSON for all input commands.
- [x] Update cleanup/touched docs for input commands.
- [x] Update README/SKILL with the `agent-screen` pairing loop.
- [x] Bump `agent-desktop` version.

## Verification

- [x] `bash -n /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh`.
- [x] `type --dry-run` returns planned action and sends no input.
- [x] `key --dry-run` returns planned action and sends no input.
- [x] `click --dry-run` returns planned action and sends no input.
- [x] Unsupported key/chord is refused.
- [x] Out-of-bounds/nonclient click is refused.
- [x] Hostile text with quotes, braces, semicolons, `$()`, and backticks is transported as literal data in dry-run and does
  not cross as executable shell syntax.
- [x] Input against a stale/mismatched ledger target is refused.
- [x] A non-owned minimized window touched by input is minimized again by `cleanup --session`.
- [x] An owned window remains owned if focus/input commands touch it later in the same session.

**Headless check:** `bash -n /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh`

**Verify:** `bash -n /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh`

## Dogfood

**Dogfood:** `bash -lc 'set -euo pipefail; evidence=/tmp/agent-desktop-input-control-340-sdd; rm -rf "$evidence"; mkdir -p "$evidence"; script=/home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh; session="dogfood-340-sdd-$(date +%s)"; cleanup(){ "$script" cleanup --session "$session" --json > "$evidence/cleanup-trap.json" 2>/dev/null || true; }; trap cleanup EXIT; "$script" launch --app "C:\Windows\System32\notepad.exe" --wait-window --timeout 20 --session "$session" --json > "$evidence/launch.json"; wid=$(node -e "const j=require(process.argv[1]); console.log(j.window_id)" "$evidence/launch.json"); expected=$(node -e "const j=require(process.argv[1]); console.log(JSON.stringify({x:j.window.x,y:j.window.y,width:j.window.width,height:j.window.height}))" "$evidence/launch.json"); "$script" key --window-id "$wid" --key ctrl+a --session "$session" --json > "$evidence/preselect.json"; "$script" key --window-id "$wid" --key backspace --session "$session" --json > "$evidence/preclean.json"; "$script" type --window-id "$wid" --text "abcxyz 123" --session "$session" --json > "$evidence/type.json"; "$script" click --window-id "$wid" --x 120 --y 160 --expected-bounds "$expected" --session "$session" --dry-run --json > "$evidence/click-dry-run.json"; "$script" key --window-id "$wid" --key ctrl+a --session "$session" --json > "$evidence/key-select.json"; "$script" key --window-id "$wid" --key backspace --session "$session" --json > "$evidence/key-clean.json"; "$script" cleanup --session "$session" --json > "$evidence/cleanup.json"; trap - EXIT; node -e "const j=require(process.argv[1]); if ((j.still_open||0)!==0) throw new Error(JSON.stringify(j)); console.log(JSON.stringify({closed:j.closed?.length||0,still_open:j.still_open||0}))" "$evidence/cleanup.json"'`

**Human dogfood:** Pair with `agent-screen screenshot --window-id <id>` before and after input to confirm the visible
native app changed as expected.

## Visual QA

- [x] Evidence: use `agent-screen` screenshots before/after dogfood input when the plugin is installed.
- [x] Evidence: `/tmp/agent-desktop-input-control-340-active3/active-after-type.png` captured Notepad after `type` and
  showed exact text `abcxyz 123`.
- [x] Evidence: `/tmp/agent-desktop-input-control-340-click` validated a real left click in the Notepad client area with
  `click.json` returning `ok=true`, absolute screen coordinates, and cleanup `still_open=0`.
- [x] Verdict: pass. `agent-screen --active` captured the post-input state; cleanup closed the owned Notepad window with
  `still_open=0`.
