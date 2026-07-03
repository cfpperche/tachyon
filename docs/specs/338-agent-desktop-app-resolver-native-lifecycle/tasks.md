# 338 — agent-desktop-app-resolver-native-lifecycle — tasks

_Generated from `plan.md` on 2026-07-03. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Fold Claude Fable probe feedback into `spec.md`/`plan.md`.
- [ ] Implement app candidate schema.
- [ ] Implement stable resolver explain schema.
- [ ] Implement explicit path candidate resolution.
- [ ] Implement built-in alias table.
- [ ] Implement App Paths registry lookup.
- [ ] Implement Start Menu `.lnk` lookup.
- [ ] Implement `PATH` lookup.
- [ ] Implement Program Files / LocalAppData search.
- [ ] Add deny-list/ranking protection for uninstall/setup/update shortcuts.
- [ ] Add ambiguity/confidence threshold for launch.
- [ ] Implement `apps find <query>`.
- [ ] Implement `apps list`.
- [ ] Implement `launch --app <query> --dry-run`.
- [ ] Implement ambiguity handling for launch candidates.
- [ ] Implement `launch --app <query> --wait-window --timeout <seconds>`.
- [ ] Take pre-launch window snapshot for ownership proof.
- [ ] Build launched process tree using pid, parent pid, start time, and executable path.
- [ ] Wait for visible non-tool top-level windows owned by launched process tree.
- [ ] Integrate wait/focus with launched native app window.
- [ ] Record `owned=true` only when new process/window identity is proven.
- [ ] Record `owned=false,touched=true` when launch reuses an existing window.
- [ ] Mark MSIX/UWP/AUMID launches `owned=false`.
- [ ] Route/refuse browser candidates to the spec 336 browser flow.
- [ ] Ensure user app query/path text is never interpolated into executable PowerShell code.
- [ ] Ensure native cleanup sends `WM_CLOSE` only and never kills GUI processes by default.
- [ ] Update cleanup docs for native app ownership limits.
- [ ] Bump `agent-desktop` version.

## Verification

- [ ] `apps find notepad` returns at least one candidate on Windows.
- [ ] `launch --app notepad --dry-run` produces a candidate and does not open a window.
- [ ] `launch --app notepad --wait-window --session <id>` opens/focuses a window and returns window identity.
- [ ] `cleanup --session <id>` closes only owned native-app windows or reports `still_open` without killing.
- [ ] `apps find blender` returns a Blender candidate when Blender is installed, or structured not-found details if not.
- [ ] Explicit executable path launch works.
- [ ] Ambiguous app query fails with candidates.
- [ ] Existing app window is not overclaimed as owned.
- [ ] Single-instance handoff is `launched=true, owned=false`.
- [ ] Launcher/updater handoff is not owned unless descendant process identity is proven.
- [ ] PID/HWND reuse after app exits is a cleanup no-op.
- [ ] Hostile app query with quotes, `$()`, semicolons, and backticks is inert data.
- [ ] Ambiguous resolver query refuses launch.
- [ ] Uninstall/setup/update shortcut is not auto-selected.
- [ ] Timeout waiting for a window returns launched-not-owned and does not kill.
- [ ] MSIX/UWP candidate is launchable but not owned, or explicitly refused.

**Verify:** `bash -n /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh`

## Dogfood

**Dogfood:** `bash -lc 'set -euo pipefail; evidence=.tachyon/evidence/agent-desktop-app-resolver; mkdir -p "$evidence"; session="dogfood-338-$(date +%s)"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh apps find notepad --json > "$evidence/find-notepad.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh launch --app notepad --dry-run --json > "$evidence/launch-dry-run.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh launch --app notepad --wait-window --timeout 20 --session "$session" --json > "$evidence/launch.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh cleanup --session "$session" --json > "$evidence/cleanup.json"'`

**Human dogfood:** If Blender is installed, run `apps find blender`, `launch --app blender --wait-window --session
<id>`, inspect with `agent-screen`, then cleanup.

## Visual QA

**Visual QA Opt-Out:** Core behavior is CLI and desktop lifecycle; optional `agent-screen` evidence should be attached
for Blender human dogfood if available.
