# 338 — agent-desktop-app-resolver-native-lifecycle — notes

_Created 2026-07-03._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

2026-07-03: spec opened from user question about whether the plugin could open Blender. Current `launch --app` can take
a path, but lacks app discovery/resolution, wait/focus integration, and generic native-app ownership. This spec scopes
that evolution.

2026-07-03: Claude Fable probe `probe-f6d11802-7ca4-46ad-9ee9-3d575f91bb87` found blocker-class gaps in the first draft:
single-instance and launcher-forwarding apps break direct PID-to-window ownership, PID/HWND reuse can close unrelated
windows, and app query/path strings crossing WSL-to-PowerShell can become command injection if interpolated. The spec now
requires pre-launch window snapshots, process-tree descendant proof with pid/start/exe, cleanup revalidation, structured
PowerShell arguments, and launched-not-owned behavior whenever proof fails.

2026-07-03: the probe also added resolver safety requirements: deterministic candidate ranking, ambiguity refusal,
deny-listing uninstall/setup/update shortcuts, explicit wait-window semantics for splash/windowless/timeout cases,
MSIX/UWP launched-not-owned scope, browser routing to spec 336, and `WM_CLOSE`-only cleanup for native GUI apps.

## Deviations

## Tradeoffs

## Open questions
