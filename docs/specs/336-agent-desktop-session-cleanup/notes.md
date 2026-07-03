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

## Deviations

## Tradeoffs

## Open questions
