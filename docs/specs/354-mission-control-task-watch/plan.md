# 354 — mission-control-task-watch — plan

_Drafted from `spec.md` on 2026-07-04. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add a Workspace-level host watcher for `.tachyon/tasks/*.json` alongside the existing `tachyon.yml` and `.tachyon/*`
watchers in `Workspace.create`. The callback schedules `deps.onViewsChanged("tasks")` through a short timer so atomic
write sequences and multiple file events collapse into one board refresh.

## Key decisions

- **Watch only task JSON files** — chosen because this task is specifically about Mission Control task records;
  rejected recursive `.tachyon/**` watching because it would mix attachments, probes, handoff, and plugin state.
- **Reuse `onViewsChanged("tasks")`** — chosen because Bridge, panels, Mission Control, Task Detail, and Task Studio
  already share that fan-out.
- **Debounce in Workspace** — chosen because host watcher implementations can emit multiple events for one logical
  atomic write.

## Files touched

- `src/workspace/Workspace.ts` — install/dispose the debounced task-file watcher.
- `test/unit/workspaceHeadless.test.ts` — cover watcher registration, callback fan-out, debounce, and disposal.
- `docs/specs/354-mission-control-task-watch/*` — spec record for `t-4bf28a`.

## Risks & unknowns

- Timer cleanup matters: disposing the Workspace should not leave a pending task refresh timer.
- Existing test fake hosts need enough watch instrumentation to trigger callbacks.

## Visual impact

No direct visual layout change. The visible effect is that open task surfaces refresh after external task-file changes.

## Sources consulted

- `src/extension.ts:438-482` — existing `onTasksChanged` fan-out.
- `src/workspace/Workspace.ts:1176-1201` — existing config and `.tachyon/*` watchers.
- `src/workspace/EngineHost.ts` / `src/workspace/VsCodeHost.ts` — runtime-neutral watcher abstraction.
