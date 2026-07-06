# 361 — reload-restore-panels-terminals — plan

_Drafted from `spec.md` on 2026-07-06. The approach, not the steps (those go in `tasks.md`)._

## Approach

1. Add a small trusted-panel serializer helper that registers `vscode.window.registerWebviewPanelSerializer` and lets managers hydrate an already-created reload panel.
2. Extend first-party panel managers to write minimal `setState` bootstrap data through the shared shell and add `deserialize` entry points. For `StudioPanelManagerBase`, include `wsKey`, `mode`, `entityId`, and the existing studio restore snapshot. Do not register plugin UI serializers.
3. Add a terminal manifest to `Terminals`: persist opened managed entries to global state, remove them on close, and expose `restoreOpen` that validates `tmux.hasSession()` before reopening.
4. Wire serializers and terminal restore in `extension.ts` after manager construction and workspace activation, using existing workspace lookup by `wsHash`.

## Key decisions

- **Use `webview.setState` via shared shell bootstrap** — chosen because VS Code passes that state to serializers after reload; rejected host-only memory because reload destroys it.
- **Keep terminals `isTransient: true`** — chosen because VS Code's native revival cannot reattach Tachyon tmux sessions; rejected non-transient terminals because they produce dead ghost shells.
- **Do not serialize plugin UI** — chosen because plugin restoration must go through broker consent and handle regeneration.

## Files touched

- `src/webview/shared/shell.ts` — bootstrap persisted webview state.
- `src/webview/shared/panelSerializer.ts` — trusted serializer helper.
- `src/webview/*Panel.ts` — first-party state and deserialize wiring.
- `src/webview/shared/studio/StudioPanelManagerBase.ts` — generic studio reload state.
- `src/presentation/Terminals.ts` — terminal-open manifest and restore.
- `src/extension.ts` — serializer registration and activation restore.
- `docs/specs/361-reload-restore-panels-terminals/*` — spec record.

## Risks & unknowns

- Webview state can be stale or malformed. Validate shape and no-op when the workspace/entity cannot be resolved.
- Terminal manifest can diverge from tmux. Validate each session before opening and prune missing sessions.
- Plugin UI restoration has security nuance. This spec does not register a serializer for plugin-host surfaces.

## Visual impact

**Visual QA Opt-Out:** reload restoration behavior is lifecycle/state plumbing; layout and styling are not changed.

## Sources consulted

- `src/webview/shared/shell.ts`
- `src/webview/MissionControlPanel.ts`
- `src/webview/TaskDetailPanel.ts`
- `src/webview/ActivityPanel.ts`
- `src/webview/HandoffPanel.ts`
- `src/webview/ServerInspector.ts`
- `src/webview/PinStudioPanel.ts`
- `src/webview/shared/studio/StudioPanelManagerBase.ts`
- `src/presentation/Terminals.ts`
- `src/extension.ts`
