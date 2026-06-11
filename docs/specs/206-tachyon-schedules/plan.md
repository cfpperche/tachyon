# 206 — tachyon-schedules — plan

_Built in ~/tachyon; SDD held by hand (npm typecheck/build/vitest/xvfb + CI)._

## Approach

A pure `Scheduler` (inject now + onFire) drives off the existing 3s ticker —
`every` = interval since last fire/activation; `at` = daily wall-clock, fired once
per day on crossing; `activate()` anchors every-schedules and handles catchUp /
suppresses already-missed at-times. onFire routes to commandRunner/runbookRunner/
manager.spawn. Agent proposals go through a `ProposalStore` (same plain-file door
as pins: `.tachyon/schedules-pending.json`), inert until the human approves —
approval = `upsertSchedule` into tachyon.yml + drop the proposal. A new
`tachyonSchedules` sidebar view shows active timers + pending proposals with
inline approve/reject; Bridge gains `propose_schedule` + `list_schedules`.

## Files to touch

**Create:** src/schedule/Scheduler.ts, src/schedule/ProposalStore.ts, test/unit/schedule.test.ts
**Modify:** loadConfig.ts (+parseEvery/parseAt, schedules parsing), YamlConfigEditor (upsert/delete/entryLine schedule), bridge/tools.ts (2 tools + deps + validateProposedSchedule), Workspace (wiring, runSchedule, approve/reject), Sidebar (SchedulesProvider + items), extension.ts (view + commands + badge), package.json/nls/l10n (0.6.0), integration fixture + suite, examples/orbit-api

## Alternatives considered

### Agents creating schedules directly (no approval)
Rejected (then refined with the user): unsupervised self-scheduling is a runaway risk. Human-approval keeps the useful part (agent notices "this should run") without the danger, and approval-writes-to-yml makes it durable config.

### A daemon for closed-editor firing
Out of scope — changes the whole architecture. Workspace-open scope is honest and matches watch-restart.

## Risks and unknowns

- Wall-clock `at` depends on local time (Date) — fine in the extension runtime; unit tests inject now and derive the target deterministically.

## Research / citations

- Reuses the executors (F15/F21), the file-door pattern (F4 pins), and the F19 monitor-tick cadence.
