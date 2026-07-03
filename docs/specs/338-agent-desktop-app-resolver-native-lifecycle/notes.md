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

2026-07-03: Notepad on this Windows host resolves first through App Paths to a packaged WindowsApps executable, but it
creates a direct `Notepad` process/window rather than an `ApplicationFrameHost` wrapper. The implementation therefore
owns packaged apps only when direct pid/start/exe/HWND/class identity is proven; indirect frame/host handoffs remain
launched-not-owned.

## Tradeoffs

2026-07-03: `apps find` returns empty candidates with `ok=true` for unresolved names, reserving non-zero `not-found`
for mutating `launch --app` selection. This keeps discovery inspectable without turning "not installed" into an
exception path.

2026-07-03: common install directory search is intentionally conservative and scores executable basenames only. A first
implementation scored full paths and made Blender discovery noisy by returning internal Python/setuptools executables.

2026-07-03: native app launches can restore recent files/projects. The README and skill now call this out as part of the
consented desktop mutation; cleanup still uses only `WM_CLOSE`.

## Validation

2026-07-03: local validation in `/home/goat/tachyon-plugins` passed:

- `bash -n agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh`
- `agent-desktop apps find notepad --json` returned `chosen` plus registry and builtin candidates.
- `agent-desktop apps find chrome --json` returned `chosen=null` and `refused_reason=browser-use-open-url`.
- `agent-desktop launch --app 'C:\WINDOWS\System32\notepad.exe' --dry-run --json` returned a literal-path candidate.
- hostile query `notepad";$(bad);` returned structured `not-found` from launch dry-run without executing anything.
- Notepad dogfood `dogfood-338-final-1783093940` launched/focused an owned window and cleanup returned `closed`.
- Blender dogfood `dogfood-338-blender-1783093870` launched/focused Blender 4.2, returned `owned=true`, and cleanup
  returned `closed`.

Evidence was written under `/home/goat/tachyon-plugins/.tachyon/evidence/agent-desktop-app-resolver/`.

2026-07-03: Claude Fable ad-hoc review via Bridge spawn `claude-fable-338-review` returned NEEDS-CHANGES. Findings
folded:

- score-100 resolver ties bypassed ambiguity refusal;
- Discord was self-denied because its Start Menu/builtin launcher is `Update.exe`;
- process `CreationDate` was collected but not checked against launch time;
- windows with empty start/executable identity could be owned and later revalidated vacuously;
- focus-denied/disappeared-window paths could orphan a proven owned window before ledger write.

Fixes applied after review:

- launch ambiguity now refuses same-score different-target ties except literal explicit paths;
- lower-priority PATH/builtin fallback scores prevent `notepad` false ambiguity while preserving real same-tier ambiguity;
- Discord `Update.exe --processStart Discord.exe` is allowed and `process_hint` is inferred from `--processStart`;
- process tree membership is limited to processes created after launch, with direct executable-path brokered launches
  allowed only when the window start time is also after launch;
- `owned=true` requires non-empty pid/process/start/executable/class identity;
- ledger ownership is written before focus so cleanup can still act if foregrounding fails;
- Start Menu targets must resolve to supported executable extensions, preventing `.ico` shortcut artifacts from being
  selected.

Post-review validation evidence:

- `fablefix2-launch.json` / `fablefix2-cleanup.json`: Notepad launched, focused, owned, and closed.
- `blender-fablefix-launch.json` / `blender-fablefix-cleanup.json`: Blender launched, focused, owned, and closed.
- `existing-discord2-launch.json` / `existing-discord2-cleanup-dry-run.json`: running Discord focused with
  `owned=false,touched=true`; cleanup dry-run had no closable windows.
- `timeout-launch.json`: explicit `where.exe` windowless launch returned exit 73, `launched=true`, `owned=false`,
  `wait_window=timeout`.
- `launch --app settings --dry-run` returned structured not-found after filtering non-executable `.ico` shortcut target.

2026-07-03: user caught a UX gap after the Discord dogfood: preexisting non-owned windows must not only survive cleanup;
they should return to their pre-agent visibility when the plugin changed it. Added touched-window restoration: the
`launch-existing` ledger records `pre_mutation_minimized`, and `cleanup --session` minimizes touched non-owned windows
that were minimized before focus. Evidence: `touch-restore-launch.json` focused the preexisting minimized Discord window
with `owned=false,touched=true`; `touch-restore-cleanup.json` returned `result=minimized` without closing it.

2026-07-03: Claude Fable re-review `claude-fable-338-rereview` found remaining issues after the first fix pass:

- no proof that cold Discord launcher handoff can be owned;
- existing-window reuse used substring process matching, so a `notepad` query could match `Notepad++`;
- `cleanup --mine` lacked the boot-marker stale-ledger guard;
- a dead Discord-specific deny-list carve-out remained.

Fixes applied: process hint matching is now exact, new-window ownership can accept a process-hint exact match created
after launch when the window was absent from the pre-launch snapshot, `cleanup --mine` marks stale boot ledgers as
`stale` instead of acting on them, and the dead deny-list carve-out was removed. Cold Discord handoff was not force-tested
because Discord was an existing user window; `existing-discord2` and `touch-restore` validate the non-owned existing path.

2026-07-03: repeated Notepad dogfoods opened a recent `captions.srt` document, and one final smoke showed the title as
`*captions.srt - Notepad` before `WM_CLOSE` was accepted. This reinforces that native `launch` may restore recent or
modified app state owned by the user. The plugin does not inspect document safety in v1; the mitigation is explicit docs
and conservative ownership/cleanup, not pretending app-level recent-file behavior is isolated.

2026-07-03: final Fable review found two merge bugs in the session ledger. A later `focus --session` could overwrite an
owned launch record with `owned=false,touched=true`, causing cleanup to leak a plugin-opened window; repeated touches
could overwrite the earliest `pre_mutation_minimized=true` with `false`. Fixed `Upsert-LedgerWindow` to never downgrade
an owned record to non-owned and to always preserve the earliest `pre_mutation_*` values. Evidence:
`owned-focus-session-before-cleanup.json` kept `owned=true` after focus and cleanup closed the Notepad window;
`touch-twice2-cleanup.json` minimized Discord after two focus touches.

## Open questions
