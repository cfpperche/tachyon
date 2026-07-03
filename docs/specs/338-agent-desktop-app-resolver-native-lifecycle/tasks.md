# 338 — agent-desktop-app-resolver-native-lifecycle — tasks

_Generated from `plan.md` on 2026-07-03. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Fold Claude Fable probe feedback into `spec.md`/`plan.md`.
- [x] Fold Claude Fable ad-hoc spawn review feedback after implementation.
- [x] Implement app candidate schema.
- [x] Implement stable resolver explain schema.
- [x] Implement explicit path candidate resolution.
- [x] Implement built-in alias table.
- [x] Implement App Paths registry lookup.
- [x] Implement Start Menu `.lnk` lookup.
- [x] Implement `PATH` lookup.
- [x] Implement Program Files / LocalAppData search.
- [x] Add deny-list/ranking protection for uninstall/setup/update shortcuts.
- [x] Add ambiguity/confidence threshold for launch.
- [x] Implement `apps find <query>`.
- [x] Implement `apps list`.
- [x] Implement `launch --app <query> --dry-run`.
- [x] Implement ambiguity handling for launch candidates.
- [x] Implement `launch --app <query> --wait-window --timeout <seconds>`.
- [x] Take pre-launch window snapshot for ownership proof.
- [x] Build launched process tree using pid, parent pid, start time, and executable path.
- [x] Wait for visible non-tool top-level windows owned by launched process tree.
- [x] Integrate wait/focus with launched native app window.
- [x] Record `owned=true` only when new process/window identity is proven.
- [x] Record `owned=false,touched=true` when launch reuses an existing window.
- [x] Mark indirect MSIX/UWP/AUMID frame/host launches `owned=false`.
- [x] Route/refuse browser candidates to the spec 336 browser flow.
- [x] Ensure user app query/path text is never interpolated into executable PowerShell code.
- [x] Ensure native cleanup sends `WM_CLOSE` only and never kills GUI processes by default.
- [x] Update cleanup docs for native app ownership limits.
- [x] Bump `agent-desktop` version.

## Verification

- [x] `apps find notepad` returns at least one candidate on Windows.
- [x] `launch --app notepad --dry-run` produces a candidate and does not open a window.
- [x] `launch --app notepad --wait-window --session <id>` opens/focuses a window and returns window identity.
- [x] `cleanup --session <id>` closes only owned native-app windows or reports `still_open` without killing.
- [x] `apps find blender` returns a Blender candidate when Blender is installed, or structured not-found details if not.
- [x] Explicit executable path launch works.
- [x] Ambiguous app query fails with candidates.
- [x] Existing app window is not overclaimed as owned.
- [x] Touched existing minimized app is restored to minimized state by cleanup.
- [x] Single-instance handoff is `launched=true, owned=false`.
- [x] Launcher/updater handoff is not owned unless descendant process identity is proven.
- [x] PID/HWND reuse after app exits is a cleanup no-op.
- [x] Hostile app query with quotes, `$()`, semicolons, and backticks is inert data.
- [x] Ambiguous resolver query refuses launch.
- [x] Uninstall/setup/update shortcut is not auto-selected.
- [x] Timeout waiting for a window returns launched-not-owned and does not kill.
- [x] Indirect MSIX/UWP candidate is launchable but not owned, or explicitly refused.

**Verify:** `bash -n /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh`

## Dogfood

**Dogfood:** `bash -lc 'set -euo pipefail; evidence=.tachyon/evidence/agent-desktop-app-resolver; mkdir -p "$evidence"; session="dogfood-338-$(date +%s)"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh apps find notepad --json > "$evidence/find-notepad.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh launch --app notepad --dry-run --json > "$evidence/launch-dry-run.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh launch --app notepad --wait-window --timeout 20 --session "$session" --json > "$evidence/launch.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh cleanup --session "$session" --json > "$evidence/cleanup.json"'`

**Human dogfood:** If Blender is installed, run `apps find blender`, `launch --app blender --wait-window --session
<id>`, inspect with `agent-screen`, then cleanup.

## Visual QA

**Visual QA Opt-Out:** Core behavior is CLI and desktop lifecycle; optional `agent-screen` evidence should be attached
for Blender human dogfood if available.
