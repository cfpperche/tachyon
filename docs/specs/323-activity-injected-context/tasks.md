# 323 — activity-injected-context — tasks

_Generated from `plan.md` on 2026-07-02._

## Implementation

- [x] `src/activity/types.ts`: add `"context.injected"` + payload `{ text, source: "hook"|"developer", hookEvent?, tagged?, truncated?, originalLength? }`.
- [x] `src/activity/claudeNormalizer.ts`: `ClaudeRecord.attachment` shape + `case "attachment"` promoting ONLY `hook_additional_context` (one event per attachment, content items joined, 4000 cap with truncated/originalLength, recordId = rec.uuid); other attachment types keep falling to raw.
- [x] `src/activity/codexNormalizer.ts`: developer-role messages emit `context.injected` (tagged computed by tolerant tag matcher; dedupe via the same seen-message mechanism, key `developer`); system role stays dropped.
- [x] `src/activity/activityView.ts`: `context.injected` → `kind: "injected"` item (skip when `tagged`); title capped like other items.
- [x] `src/webview/activity/App.tsx`: exhaustive kind→icon entry + compact render branch (hover "Injected context").

## Verification

- [x] claudeNormalizer: hook_additional_context → one `context.injected` (joined content, uuid recordId); hook_success/task_reminder/skill_listing stay raw; long content sets truncated+originalLength.
- [x] codexNormalizer: plain-prose developer → `context.injected` untagged; `<permissions instructions>`/`<collaboration_mode>`/uppercase-attr tags → tagged:true (still emitted); duplicated developer records within 2s dedupe to one; system role emits nothing.
- [x] activityView: `context.injected` untagged → "injected" item; tagged → no item; mixed log with `system.nudge` + `context.injected` renders both correctly.
- [x] Full unit suite + typecheck green.

**Headless check:** `env -u TMUX npx vitest run test/unit/claudeNormalizer.test.ts test/unit/codexNormalizer.test.ts test/unit/activityView.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`

**Verify:** `env -u TMUX npx vitest run test/unit/claudeNormalizer.test.ts test/unit/codexNormalizer.test.ts test/unit/activityView.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`

## Dogfood

**Dogfood:** `env -u TMUX npx vitest run test/unit/claudeNormalizer.test.ts test/unit/codexNormalizer.test.ts -t "injected"`

**Human dogfood:** Rebuild + reload, open the claude agent's Activity — after the next restart/resume, the SessionStart hook pointers (handoff/continuity) should appear as compact "injected" chips at the session boundary; the codex agent's Activity should show its injected pointers too, with no `<permissions instructions>` preamble in the feed.
