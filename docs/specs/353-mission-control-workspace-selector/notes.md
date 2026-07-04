# 353 — mission-control-workspace-selector — notes

_Created 2026-07-04._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Dogfood observations

- Creating `t-954351` by writing `.tachyon/tasks/t-954351.json` directly did not update an already-open Mission
  Control panel. The task was valid and visible to the Bridge, but the panel snapshot was stale until the task was
  patched through `update_task`, which fired the normal `onTasksChanged` fan-out. This is the known out-of-band
  refresh gap tracked by `t-4bf28a`, not a regression from this spec.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Verification log

### 2026-07-04T17:18:33Z — pass (1/1) — source: tasks.md
- `npm test -- test/unit/missionControlPanel.test.ts && npm run build && npm run test:browser -- test/browser/boardHeaderKitParity.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit` — pass
