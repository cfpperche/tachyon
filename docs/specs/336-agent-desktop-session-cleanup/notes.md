# 336 — agent-desktop-session-cleanup — notes

_Created 2026-07-03._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

2026-07-03: spec opened after user dogfood reported waking up to multiple Chrome windows left by `agent-desktop` v0.1.0.
This is treated as a product/DX bug in the plugin contract, not merely test cleanup.

2026-07-03: Claude Fable probe `probe-4e4c0a43-c447-4207-b02d-40c6d107046b` found two blocker-class safety issues in
the first draft: HWND/window id alone is unsafe because Windows can reuse handles, and normal Chrome launch can hand URLs
to an existing user browser process. Direction changed to use a dedicated Chrome `--user-data-dir` per session plus
identity revalidation before close: HWND, pid, process start time, process name, window class, and session profile.

2026-07-03: probe also pushed the spec to add dry-run/audit commands, per-window cleanup states, atomic ledger writes,
host boot/stale handling, corrupt ledger recovery, hostile-title PowerShell hardening, and `doctor` preflight checks for
non-installable requirements.

2026-07-03 implementation: Chrome rejected a dedicated `--user-data-dir` under the WSL/UNC workspace path and opened a
"Profile error occurred" window. The implementation now stores session ledgers in the workspace
`.tachyon/agent-desktop/sessions/`, but creates Chrome session profiles under Windows `%TEMP%\agent-desktop-profiles`.
This keeps cleanup ownership isolated without relying on a Chrome profile stored on UNC.

2026-07-03 validation: final dogfood opened two Chrome URLs in session `dogfood-336-1783086977`, verified dry-run would
close both, then `cleanup --session` closed both. `sessions show` reported `open_owned_count=0`; a second cleanup
reported `already_closed`. Separate `close --window-id` dogfood closed a one-window session. Corrupt ledger and unknown
close paths failed closed with structured JSON.

2026-07-03 shipped plugin commit/tag: `/home/goat/tachyon-plugins` commit `2db368d`, tag `v0.29.1`, install source
`github:cfpperche/tachyon-plugins@v0.29.1#path=agent-desktop`.

## Deviations

## Tradeoffs

## Open questions

## Verification log

### 2026-07-03T14:01:21Z — pass (1/1) — source: tasks.md
- `bash -n /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh` — pass

## Dogfood log

### 2026-07-03T14:01:22Z — pass (1/1) — source: tasks.md — commit: ebcddf13462a77d8c5f4ea1c63a868827fcbdb4c
- `bash -lc 'set -euo pipefail; evidence=.tachyon/evidence/agent-desktop-cleanup-v11; mkdir -p "$evidence"; session="dogfood-336-$(date +%s)"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh open-url --browser chrome --new-window https://example.com --session "$session" --json > "$evidence/open-1.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh open-url --browser chrome --new-window https://www.iana.org/domains/reserved --session "$session" --json > "$evidence/open-2.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh cleanup --session "$session" --dry-run --json > "$evidence/dry-run.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh cleanup --session "$session" --json > "$evidence/cleanup.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh sessions show --session "$session" --json > "$evidence/session-after.json"; node -e "const fs=require(\"fs\"); const c=JSON.parse(fs.readFileSync(process.argv[1], \"utf8\")); if (!c.ok || !c.closed || c.closed.length < 2) process.exit(1)" "$evidence/cleanup.json"'` — pass
