# 340 — agent-desktop-input-control — tasks

_Generated from `plan.md` on 2026-07-03. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Fold Claude Fable ad-hoc review feedback into `spec.md`/`plan.md`.
- [ ] Add PowerShell input helpers for keyboard text, key chords, and mouse click.
- [ ] Add explicit `--window-id` target resolution for input commands.
- [ ] Require `--session` for all input commands.
- [ ] Add session ledger lookup and identity verification before every input.
- [ ] Add per-input ledger events for dry-run and mutating actions.
- [ ] Add touched-window recording before focus for non-owned targets.
- [ ] Add `type --window-id <id> --text <text> --session <id> [--dry-run]`.
- [ ] Transport `type` text as base64 UTF-8 into PowerShell.
- [ ] Implement literal text injection with `SendInput` `KEYEVENTF_UNICODE`, not `SendKeys`.
- [ ] Refuse multiline/control text and text longer than 1024 characters.
- [ ] Add `key --window-id <id> --key <key-or-chord> --session <id> [--dry-run]`.
- [ ] Define and enforce a narrow key/chord allow-list.
- [ ] Release synthetic modifiers on every key path.
- [ ] Add `click --window-id <id> --x <px> --y <px> --session <id> [--expected-bounds <json>] [--dry-run]`.
- [ ] Treat click coordinates as screenshot/DWM-bounds-relative, not client-relative.
- [ ] Re-fetch bounds immediately before click and refuse expected-bounds mismatch.
- [ ] Refuse nonclient clicks.
- [ ] Refuse obscured clicks via `WindowFromPoint` root-window verification.
- [ ] Verify foreground target immediately before sending input.
- [ ] Include post-input foreground identity in JSON for mutating input commands.
- [ ] Ensure dry-run sends no keyboard or mouse input.
- [ ] Return stable JSON for all input commands.
- [ ] Update cleanup/touched docs for input commands.
- [ ] Update README/SKILL with the `agent-screen` pairing loop.
- [ ] Bump `agent-desktop` version.

## Verification

- [ ] `bash -n /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh`.
- [ ] `type --dry-run` returns planned action and sends no input.
- [ ] `key --dry-run` returns planned action and sends no input.
- [ ] `click --dry-run` returns planned action and sends no input.
- [ ] Unsupported key/chord is refused.
- [ ] Out-of-bounds click is refused.
- [ ] Hostile text with quotes, braces, semicolons, `$()`, and backticks is typed as literal data or refused safely.
- [ ] Input against a stale/mismatched ledger target is refused.
- [ ] A non-owned minimized window touched by input is minimized again by `cleanup --session`.
- [ ] An owned window remains owned if focus/input commands touch it later in the same session.

**Headless check:** `bash -n /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh`

**Verify:** `bash -n /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh`

## Dogfood

**Dogfood:** `bash -lc 'set -euo pipefail; evidence=.tachyon/evidence/agent-desktop-input-control; mkdir -p "$evidence"; script=/home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh; session="dogfood-340-$(date +%s)"; "$script" launch --app notepad --wait-window --timeout 20 --session "$session" --json > "$evidence/launch.json"; wid=$(python3 -c "import json; print(json.load(open(\"$evidence/launch.json\"))[\"window_id\"])"); "$script" type --window-id "$wid" --text "tachyon input dogfood" --session "$session" --json > "$evidence/type.json"; "$script" key --window-id "$wid" --key ctrl+a --session "$session" --json > "$evidence/key-select.json"; "$script" key --window-id "$wid" --key backspace --session "$session" --json > "$evidence/key-clean.json"; "$script" click --window-id "$wid" --x 20 --y 80 --session "$session" --dry-run --json > "$evidence/click-dry-run.json"; "$script" cleanup --session "$session" --json > "$evidence/cleanup.json"; python3 -c "import json; d=json.load(open(\"$evidence/cleanup.json\")); assert d.get(\"still_open\", 0) == 0, d"'`

**Human dogfood:** Pair with `agent-screen screenshot --window-id <id>` before and after input to confirm the visible
native app changed as expected.

## Visual QA

- [ ] Evidence: use `agent-screen` screenshots before/after dogfood input when the plugin is installed.
- [ ] Verdict: pending implementation.
