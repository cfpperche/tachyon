# 324 — activity-share-actions — plan

_Drafted from `spec.md` on 2026-07-02. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add a small, typed share layer around the existing Activity view:

1. Mark which rendered `ActivityItem`s are shareable by deriving a bounded text payload from the existing
   view-model fields (`title`, `detail`, `result`, `resultFull`) instead of reaching back into raw logs.
2. Render two hover/focus actions on supported rows:
   - external share, handled by the VS Code host;
   - send to Tachyon agent, handled by the VS Code host.
3. Extend the Activity webview message contract with `shareExternal` and `shareToAgent` messages carrying the
   selected item's `sequence` plus a deterministic item token. The host resolves the sequence against the last
   posted VM and recomputes the token; mismatch means the item is stale and the action is refused. The webview
   never provides arbitrary text for privileged actions.
4. External share opens a QuickPick of deterministic channels. v1 uses:
   - Email (`mailto:`);
   - WhatsApp Web (`https://wa.me/?text=...`);
   - Copy share text (clipboard fallback).
5. Internal share opens a QuickPick of other running AI agents in the same workspace and pastes a formatted prompt
   to the chosen agent's tmux session **without pressing Enter**. Activity content may contain untrusted model
   output or injected context, so v1 stages the prompt and lets the user submit deliberately.

## Key decisions

- **Share one Activity item, not arbitrary selection** — chosen because Activity items already have stable
  sequence ids and provenance; arbitrary DOM selection would force the host to trust webview-provided text.
- **Host resolves share content by sequence** — chosen because the extension host has the trusted VM and can
  bound/format payloads. A deterministic item token is added to catch stale/reused sequence races; rejected sending
  full payload text from the webview because it widens the webview trust surface unnecessarily.
- **Deterministic external channels in v1** — chosen because VS Code webviews do not offer a stable native
  browser share-sheet across desktop/remote; rejected `navigator.share` as the primary path.
- **Paste without submit for internal send** — chosen because Activity content may include arbitrary model output,
  injected context, or shell-like text; rejected `tmux.sendKeys(..., enter=true)` because it can become prompt or
  shell injection if the destination pane is not at a safe prompt.
- **Only running AI agents are destinations** — chosen because stopped agents cannot receive input and terminal
  rows are not LLM sessions; rejected auto-resume because sharing should not unexpectedly start sessions.

## Files touched

- `src/activity/activityShare.ts` — pure formatting and eligibility helpers.
- `src/activity/activityView.ts` — include enough context in each `ActivityItem` if needed; keep pure.
- `src/webview/activity/messages.ts` — typed webview→host share messages.
- `src/webview/activity/App.tsx` / `main.tsx` — render share actions and dispatch item sequence.
- `src/webview/activity/activity.css` — compact hover/focus controls.
- `src/webview/ActivityPanel.ts` — resolve share actions, QuickPick external/internal destinations, call clipboard/openExternal/tmux.
- `src/workspace/Workspace.ts` or `AgentManager` — expose a small destination helper if the panel should not reach internals directly.
- `test/unit/activityShare.test.ts` — pure payload and destination tests.
- Existing Activity view tests — cover unsupported items / no clutter regressions where practical.

## Risks & unknowns

- Activity item `sequence` is synthesized per panel render. The host must resolve against the latest posted VM; if
  an item falls out of the loaded window before click handling, or its token mismatches, fail with a clear message
  instead of sharing wrong text.
- `mailto:` and `wa.me` behavior depends on the user's OS/browser handlers and URL length limits; copying is the
  deterministic fallback, and external URL payloads are capped/truncated before encoding.
- External share can leak injected context; show a preview/confirmation before leaving Tachyon.
- Internal paste is powerful: avoid sending to the same source agent by default to reduce accidental self-feedback loops,
  re-check destination liveness at send time, and paste without submit.
- Very large tool outputs can be noisy; cap shared text and mark truncation.

## Sources consulted

- `src/webview/ActivityPanel.ts` — Activity panel host, durable log read, webview message handling.
- `src/webview/activity/App.tsx` and `main.tsx` — rendered feed and current dispatch shape.
- `src/webview/activity/messages.ts` — existing typed host→webview message envelope.
- `src/activity/activityView.ts` — `ActivityItem` shape and item kinds.
- `src/sidebar/actions.ts` — Activity availability is AI-agent scoped.
- `src/workspace/Workspace.ts` / `src/agents/AgentManager.ts` — agent state, resume/running checks, `tmux.sendKeys` usage.
