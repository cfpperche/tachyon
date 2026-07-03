# 340 — agent-desktop-input-control — notes

_Created 2026-07-03._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

2026-07-03: Claude Fable ad-hoc review via Bridge spawn `claude-fable-340-spec-review` returned NEEDS-CHANGES. Folded
the six major findings before implementation:

- click coordinates are screenshot/DWM-bounds-relative, not Win32 client-relative;
- click must refuse topmost-at-point mismatch/obscured targets;
- click must refuse nonclient/title-bar points so input cannot close user windows through the side door;
- `--session` is mandatory for `type`/`key`/`click`, with per-input ledger events;
- dogfood must not leave dirty Notepad/save prompts unless explicitly testing that cleanup behavior;
- `type` uses base64 UTF-8 transport plus Win32 `SendInput`, not `SendKeys`.

Folded minor findings too: explicit key allow-list, foreground verification immediately before injection, post-input
foreground identity in JSON, modifier release hygiene, single-left-click semantics, and pinned exit-code mapping.

2026-07-03: Implementation dogfood found pure `KEYEVENTF_UNICODE` was not reliable in modern Windows Notepad: visual
evidence showed `abcxyz 123` arriving as `abcxyz 333`. Adjusted the spec and implementation to still avoid `SendKeys`,
but send printable ASCII through `VkKeyScanW` virtual-key events via Win32 `SendInput`, with Unicode events only as a
fallback. Retest evidence `/tmp/agent-desktop-input-control-340-active3/active-after-type.png` showed exact text
`abcxyz 123`; cleanup closed the owned Notepad window with `still_open=0`.

2026-07-03: Claude Fable implementation review via Bridge spawn `claude-fable-340-impl-review` returned NEEDS-CHANGES:

- Major 1: post-focus failures could restore/focus a non-owned window before the touch record or failure event was
  persisted. Fixed by writing new touch records immediately before focus and adding a pending-input failure hook in
  `Finish` so post-touch failures append an `input` ledger event.
- Major 2: canonical SDD dogfood had downgraded click to dry-run after a focus race. Kept canonical dogfood stable with
  dry-run click, but recorded separate real-click evidence from `/tmp/agent-desktop-input-control-340-click` where
  `click.json` returned `ok=true` and cleanup closed the owned window with `still_open=0`.
- Minors fixed: type timeout now scales with text length, C1/control characters use `[char]::IsControl`, partial
  `SendInput` failure re-releases the primary key as well as modifiers, input checks ledger `host_boot`, and
  `Resolve-InputWindow` only accepts visible top-level windows from `Get-Windows`.

2026-07-03: Stale/mismatched ledger validation passed in `/tmp/agent-desktop-input-control-340-stale2`: after corrupting
the ledger pid for a controlled Notepad session, `key --dry-run` returned exit 72 `mismatched`; restoring the original
ledger allowed cleanup to close the owned window with `still_open=0`.

2026-07-03: Non-owned touched-window restoration validation passed in
`/tmp/agent-desktop-input-control-340-touched-min2`: a Notepad window launched outside any session was minimized, touched
with `key escape --session`, and `cleanup --session` returned restored result `minimized` with `closed=0`.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Verification log

### 2026-07-03T17:29:39Z — pass (1/1) — source: tasks.md
- `bash -n /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh` — pass

## Dogfood log

### 2026-07-03T17:30:17Z — fail (0/1) — source: tasks.md — commit: ca409b3bfd38816619e1ca9a838de53b5cc1d641
- `bash -lc 'set -euo pipefail; evidence=/tmp/agent-desktop-input-control-340-sdd; rm -rf "$evidence"; mkdir -p "$evidence"; script=/home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh; session="dogfood-340-sdd-$(date +%s)"; cleanup(){ "$script" cleanup --session "$session" --json > "$evidence/cleanup-trap.json" 2>/dev/null || true; }; trap cleanup EXIT; "$script" launch --app "C:\Windows\System32\notepad.exe" --wait-window --timeout 20 --session "$session" --json > "$evidence/launch.json"; wid=$(node -e "const j=require(process.argv[1]); console.log(j.window_id)" "$evidence/launch.json"); expected=$(node -e "const j=require(process.argv[1]); console.log(JSON.stringify({x:j.window.x,y:j.window.y,width:j.window.width,height:j.window.height}))" "$evidence/launch.json"); "$script" key --window-id "$wid" --key ctrl+a --session "$session" --json > "$evidence/preselect.json"; "$script" key --window-id "$wid" --key backspace --session "$session" --json > "$evidence/preclean.json"; "$script" type --window-id "$wid" --text "abcxyz 123" --session "$session" --json > "$evidence/type.json"; "$script" click --window-id "$wid" --x 120 --y 160 --expected-bounds "$expected" --session "$session" --json > "$evidence/click.json"; "$script" key --window-id "$wid" --key ctrl+a --session "$session" --json > "$evidence/key-select.json"; "$script" key --window-id "$wid" --key backspace --session "$session" --json > "$evidence/key-clean.json"; "$script" cleanup --session "$session" --json > "$evidence/cleanup.json"; trap - EXIT; node -e "const j=require(process.argv[1]); if ((j.still_open||0)!==0) throw new Error(JSON.stringify(j)); console.log(JSON.stringify({closed:j.closed?.length||0,still_open:j.still_open||0}))" "$evidence/cleanup.json"'` — fail

### 2026-07-03T17:31:44Z — pass (1/1) — source: tasks.md — commit: ca409b3bfd38816619e1ca9a838de53b5cc1d641
- `bash -lc 'set -euo pipefail; evidence=/tmp/agent-desktop-input-control-340-sdd; rm -rf "$evidence"; mkdir -p "$evidence"; script=/home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh; session="dogfood-340-sdd-$(date +%s)"; cleanup(){ "$script" cleanup --session "$session" --json > "$evidence/cleanup-trap.json" 2>/dev/null || true; }; trap cleanup EXIT; "$script" launch --app "C:\Windows\System32\notepad.exe" --wait-window --timeout 20 --session "$session" --json > "$evidence/launch.json"; wid=$(node -e "const j=require(process.argv[1]); console.log(j.window_id)" "$evidence/launch.json"); expected=$(node -e "const j=require(process.argv[1]); console.log(JSON.stringify({x:j.window.x,y:j.window.y,width:j.window.width,height:j.window.height}))" "$evidence/launch.json"); "$script" key --window-id "$wid" --key ctrl+a --session "$session" --json > "$evidence/preselect.json"; "$script" key --window-id "$wid" --key backspace --session "$session" --json > "$evidence/preclean.json"; "$script" type --window-id "$wid" --text "abcxyz 123" --session "$session" --json > "$evidence/type.json"; "$script" click --window-id "$wid" --x 120 --y 160 --expected-bounds "$expected" --session "$session" --dry-run --json > "$evidence/click-dry-run.json"; "$script" key --window-id "$wid" --key ctrl+a --session "$session" --json > "$evidence/key-select.json"; "$script" key --window-id "$wid" --key backspace --session "$session" --json > "$evidence/key-clean.json"; "$script" cleanup --session "$session" --json > "$evidence/cleanup.json"; trap - EXIT; node -e "const j=require(process.argv[1]); if ((j.still_open||0)!==0) throw new Error(JSON.stringify(j)); console.log(JSON.stringify({closed:j.closed?.length||0,still_open:j.still_open||0}))" "$evidence/cleanup.json"'` — pass

### 2026-07-03T17:33:49Z — pass (1/1) — source: tasks.md — commit: ca409b3bfd38816619e1ca9a838de53b5cc1d641
- `bash -lc 'set -euo pipefail; evidence=/tmp/agent-desktop-input-control-340-sdd; rm -rf "$evidence"; mkdir -p "$evidence"; script=/home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh; session="dogfood-340-sdd-$(date +%s)"; cleanup(){ "$script" cleanup --session "$session" --json > "$evidence/cleanup-trap.json" 2>/dev/null || true; }; trap cleanup EXIT; "$script" launch --app "C:\Windows\System32\notepad.exe" --wait-window --timeout 20 --session "$session" --json > "$evidence/launch.json"; wid=$(node -e "const j=require(process.argv[1]); console.log(j.window_id)" "$evidence/launch.json"); expected=$(node -e "const j=require(process.argv[1]); console.log(JSON.stringify({x:j.window.x,y:j.window.y,width:j.window.width,height:j.window.height}))" "$evidence/launch.json"); "$script" key --window-id "$wid" --key ctrl+a --session "$session" --json > "$evidence/preselect.json"; "$script" key --window-id "$wid" --key backspace --session "$session" --json > "$evidence/preclean.json"; "$script" type --window-id "$wid" --text "abcxyz 123" --session "$session" --json > "$evidence/type.json"; "$script" click --window-id "$wid" --x 120 --y 160 --expected-bounds "$expected" --session "$session" --dry-run --json > "$evidence/click-dry-run.json"; "$script" key --window-id "$wid" --key ctrl+a --session "$session" --json > "$evidence/key-select.json"; "$script" key --window-id "$wid" --key backspace --session "$session" --json > "$evidence/key-clean.json"; "$script" cleanup --session "$session" --json > "$evidence/cleanup.json"; trap - EXIT; node -e "const j=require(process.argv[1]); if ((j.still_open||0)!==0) throw new Error(JSON.stringify(j)); console.log(JSON.stringify({closed:j.closed?.length||0,still_open:j.still_open||0}))" "$evidence/cleanup.json"'` — pass

### 2026-07-03T17:40:33Z — pass (1/1) — source: tasks.md — commit: ca409b3bfd38816619e1ca9a838de53b5cc1d641
- `bash -lc 'set -euo pipefail; evidence=/tmp/agent-desktop-input-control-340-sdd; rm -rf "$evidence"; mkdir -p "$evidence"; script=/home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh; session="dogfood-340-sdd-$(date +%s)"; cleanup(){ "$script" cleanup --session "$session" --json > "$evidence/cleanup-trap.json" 2>/dev/null || true; }; trap cleanup EXIT; "$script" launch --app "C:\Windows\System32\notepad.exe" --wait-window --timeout 20 --session "$session" --json > "$evidence/launch.json"; wid=$(node -e "const j=require(process.argv[1]); console.log(j.window_id)" "$evidence/launch.json"); expected=$(node -e "const j=require(process.argv[1]); console.log(JSON.stringify({x:j.window.x,y:j.window.y,width:j.window.width,height:j.window.height}))" "$evidence/launch.json"); "$script" key --window-id "$wid" --key ctrl+a --session "$session" --json > "$evidence/preselect.json"; "$script" key --window-id "$wid" --key backspace --session "$session" --json > "$evidence/preclean.json"; "$script" type --window-id "$wid" --text "abcxyz 123" --session "$session" --json > "$evidence/type.json"; "$script" click --window-id "$wid" --x 120 --y 160 --expected-bounds "$expected" --session "$session" --dry-run --json > "$evidence/click-dry-run.json"; "$script" key --window-id "$wid" --key ctrl+a --session "$session" --json > "$evidence/key-select.json"; "$script" key --window-id "$wid" --key backspace --session "$session" --json > "$evidence/key-clean.json"; "$script" cleanup --session "$session" --json > "$evidence/cleanup.json"; trap - EXIT; node -e "const j=require(process.argv[1]); if ((j.still_open||0)!==0) throw new Error(JSON.stringify(j)); console.log(JSON.stringify({closed:j.closed?.length||0,still_open:j.still_open||0}))" "$evidence/cleanup.json"'` — pass
