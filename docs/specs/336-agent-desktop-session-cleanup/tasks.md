# 336 — agent-desktop-session-cleanup — tasks

_Generated from `plan.md` on 2026-07-03. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Fold Claude Fable probe feedback into `spec.md`/`plan.md`.
- [x] Decide ledger path and session id format.
- [x] Add schema version and host boot/session marker to ledger records.
- [x] Add atomic ledger write helper.
- [x] Implement session id generation and `--session <id>` parsing.
- [x] Launch Chrome `open-url` with a dedicated per-session `--user-data-dir`.
- [x] Persist `open-url` ownership records with `owned=true` and identity tuple.
- [x] Do not claim generic `launch` ownership unless a future command can prove process/window identity safely.
- [x] Persist `focus`/`restore` touch records with `owned=false` when `--session` is supplied.
- [x] Implement live identity verification for HWND + pid + process start time + process name + window class + session profile.
- [x] Implement `sessions list`.
- [x] Implement `sessions show --session <id>`.
- [x] Implement `close --window-id <id>` for owned ledger records.
- [x] Implement `cleanup --session <id>`.
- [x] Implement `cleanup --session <id> --dry-run`.
- [x] Implement `cleanup --mine` if ownership can be scoped safely to plugin-created sessions in the workspace.
- [x] Validate stale/reused HWND before close.
- [x] Make cleanup idempotent for already-closed windows.
- [x] Return per-window cleanup states: `closed`, `already_closed`, `still_open`, `stale`, `mismatched`, `not_owned`.
- [x] Ensure cleanup uses `WM_CLOSE` and does not terminate processes by default.
- [x] Harden PowerShell invocation against hostile titles/URLs.
- [x] Improve `doctor` preflight for WSL, PowerShell, `wslpath`, Chrome, and docs pointers.
- [x] Update README/SKILL with cleanup examples and environment requirements.
- [x] Bump `agent-desktop` manifest version.

## Verification

- [x] `bash -n` passes for the plugin script.
- [x] `open-url --session <id>` returns `owned=true`, `session_id`, and `window_id`.
- [x] Ledger file exists and records the owned window identity tuple.
- [x] Chrome URL windows use a dedicated session profile rather than the user's normal Chrome profile.
- [x] `sessions show --session <id>` reports owned windows and live verification status.
- [x] `cleanup --session <id> --dry-run` reports what would close without closing anything.
- [x] `cleanup --session <id>` closes owned windows and updates ledger records.
- [x] Re-running cleanup is idempotent.
- [x] A preexisting window touched by focus/restore is not closed by cleanup.
- [x] `close --window-id <id>` refuses unknown/not-owned windows.
- [x] A stale/reused HWND or mismatched identity is not closed.
- [x] Hostile window titles containing quotes, `$()`, or backticks do not break parsing or execute code.
- [x] Corrupt/stale ledger is handled without closing windows.
- [x] Docs state WSL/PowerShell/`wslpath`/Chrome requirements despite no installable dependencies.

**Verify:** `bash -n /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh`

## Dogfood

**Dogfood:** `bash -lc 'set -euo pipefail; evidence=.tachyon/evidence/agent-desktop-cleanup-v11; mkdir -p "$evidence"; session="dogfood-336-$(date +%s)"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh open-url --browser chrome --new-window https://example.com --session "$session" --json > "$evidence/open-1.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh open-url --browser chrome --new-window https://www.iana.org/domains/reserved --session "$session" --json > "$evidence/open-2.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh cleanup --session "$session" --dry-run --json > "$evidence/dry-run.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh cleanup --session "$session" --json > "$evidence/cleanup.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh sessions show --session "$session" --json > "$evidence/session-after.json"; node -e "const fs=require(\"fs\"); const c=JSON.parse(fs.readFileSync(process.argv[1], \"utf8\")); if (!c.ok || !c.closed || c.closed.length < 2) process.exit(1)" "$evidence/cleanup.json"'`

**Human dogfood:** Install the new plugin version, open two Chrome windows with a shared `--session`, run cleanup, and
confirm no plugin-opened Chrome windows remain.

## Visual QA

**Visual QA Opt-Out:** This spec changes CLI behavior and desktop side effects; dogfood verifies window cleanup directly.
