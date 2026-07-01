# 306 — provider-throttle-attention — tasks

_Generated from `plan.md` on 2026-06-30. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] `src/attention/patterns.ts`: add `PROVIDER_ERROR_PATTERNS` (codex's contextual regex list) and a unified `classifyAttentionTail(paneText, extraPromptPatterns)` that walks the tail bottom-up once, returning `{ line, pattern, kind: "error" | "prompt" } | null` (bottom-most match wins; same-line ties favor `"error"`). Keep `classifyTail`/error-only matching independently testable.
- [x] `src/attention/AttentionMonitor.ts`: extend `AttentionState` with `"throttled"`; replace the `classifyTail` call in `tick()`'s stable-content branch with the unified classifier, branching to `throttled`/`needs-input` per `kind`. Add `THROTTLE_NOTIFY_DELAY_MS` constant.
- [x] `AttentionMonitor.tick()`: inside the same per-agent loop (after classification, not a separate pass), when `snap.state === "throttled"` and unchanged, check `now - snap.stateSince >= THROTTLE_NOTIFY_DELAY_MS && snap.notifiedEpisode !== snap.stateSince` → stamp `notifiedEpisode` and re-invoke `onChange` with `notify: true`.
- [x] `src/workspace/Workspace.ts`: add a `throttled`+`notify` branch to the `AttentionMonitor` `onChange` wiring (~`:423-442`), mirroring the `needs-input` toast (same `terminals.isActive` suppression).
- [x] `src/sidebar/types.ts`: add `"throttled"` to `AgentStatus`.
- [x] `src/sidebar/agentModel.ts`: `statusOf()` gains a `throttled` branch; `toAgentVM()`'s attention-label mapping passes `"throttled"` through.
- [x] `src/sidebar/actions.ts`: add `"throttled"` to the `isRunning` predicate (`:35`).
- [x] `src/webview/sidebar/App.tsx`: add `"throttled"` to `STATUS_ORDER` (after `needs`, before `idle`) and `STATUS_LABEL` (`"Throttled"`).
- [x] `src/webview/sidebar/sidebar.css`: add `.sdot.throttled` — `--ds-warn` fill, no glow, plus a visible darker-amber outline.

## Verification

- [x] Stable provider-error text → `throttled` (maps to spec.md's first throttled scenario).
- [x] A newer bottom-most prompt line beats an older error line still in the tail window → `needs-input`, not `throttled` (maps to the bottom-most-match acceptance scenario).
- [x] A single line matching both pattern sets → `throttled` (tie-break).
- [x] Pane content changes while throttled → back to `working`, no notify fires (maps to "transient error self-resolves").
- [x] Sustained throttle past `THROTTLE_NOTIFY_DELAY_MS` → exactly one `notify: true`; a later tick past the same threshold does not re-notify (maps to "sustained throttle fires exactly one notification").
- [x] An agent removed from tracking this tick never fires a stale sustained notify.
- [x] `statusOf`/`toAgentVM` produce `"throttled"` correctly (`agentModel.test.ts`).
- [x] A `"throttled"` agent still offers `reanchor`/`reinjectContinuity` (`sidebarActions.test.ts`, maps to the actions.ts acceptance criterion).
- [x] Pre-existing `attention.test.ts`/`agentModel.test.ts`/`sidebarActions.test.ts` cases pass unmodified in intent.
- [x] Typecheck passes (main + webview).

**Headless check:** `env -u TMUX npx vitest run test/unit/attention.test.ts test/unit/agentModel.test.ts test/unit/sidebarActions.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`

**Verify:** `env -u TMUX npx vitest run test/unit/attention.test.ts test/unit/agentModel.test.ts test/unit/sidebarActions.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`

## Dogfood

**Dogfood-Opt-Out:** The detection/state-machine/action-gating logic is fully covered by the unit suite (pure functions/classes with injected `MonitorIO`/`now()`, no real tmux/timers needed to exercise the throttled path end-to-end). A meaningful headless dogfood would require fabricating a live tmux pane that prints a provider-error banner, which duplicates what the unit tests already prove deterministically; visual confirmation of the new dot/badge/toast is left to human dogfood below.

**Human dogfood:** Rebuild + reload the extension, run an agent, and simulate a throttled pane (e.g. `echo "Error: rate limit exceeded, please try again later" > /dev/null` inside the agent's pane, or `tmux send-keys` a matching line into its session) — confirm the sidebar row switches to the new `throttled` dot/badge within `PATTERN_STABLE_MS`, that it reverts to `working` if the pane changes before `THROTTLE_NOTIFY_DELAY_MS`, and that a toast fires exactly once if it stays throttled past that delay.
