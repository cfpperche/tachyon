# 325 — task-queue-entity — tasks

_Generated from `plan.md` on 2026-07-02. NOT started — awaiting the maintainer's go (spec-first delivery)._

## Implementation

- [ ] `src/tasks/types.ts`: `Task` + status enum + the mutability/transition tables as typed constants.
- [ ] `src/tasks/TaskStore.ts`: per-task files in `.tachyon/tasks/` — create via tmp+`linkSync` (EEXIST ⇒ re-mint id), update via tmp+rename under a per-store async mutex with CAS preconditions; `list()` dir-scan ignoring `*.tmp.*`, skipping corrupt JSON with structured warnings.
- [ ] `src/tasks/nextTask.ts`: pure selection (two tiers, dependency-aware exclusion, priority→rank→createdAt→id, structured empty reasons).
- [ ] `src/bridge/tools.ts`: `create_task` / `get_task` / `update_task` (with `expect` CAS) / `list_tasks` (bounded, no body) / `next_task` — pin-block conventions, `onViewsChanged("tasks")`.
- [ ] `src/workspace/Workspace.ts`: construct + expose the store.
- [ ] Optional artifact-enrichment helper for `artifact_refs` entries with `type:"sdd"` (reads local spec `**Status:**` by convention when the file exists, maps superseded/abandoned/deferred to attention flags, and degrades to context/attention when SDD is absent; no SDD plugin runtime dependency).

## Verification

- [ ] TaskStore: exclusive create (concurrent same-id ⇒ one wins, one re-mints); CAS claim (two claimers ⇒ one `precondition-failed`); corrupt/tmp files never listed; mutability/transition table enforced fail-closed.
- [ ] nextTask: dependency exclusion (both tiers), dangling dep resolved with attention, assigned-active SDD actionable/excluded/retriage/ready-to-close cases, tier policy, priority ordering (`0` first, absent last), optional rank before `createdAt`, human-assigned reservation, all three empty reasons.
- [ ] Bridge: validation bounds (trim/non-empty/code-points/priority/rank/kind/status/deps/artifact_refs), `artifact_refs` max/dedupe/open types, assignee accepts `"human"` and open agent names, bounded list + get_task, author defaulting mirrors pins.
- [ ] Optional SDD integration: core task create/list/update/next works with no `docs/specs` and no SDD plugin assumptions; `artifact_refs` accepts unknown open `type` strings while recognized `sdd` refs derive status only when local specs exist; missing SDD specs, shipped-ready-to-close, and lifecycle edge states surface attention without changing stored status.
- [ ] Persisted-vs-derived split: task JSON never stores attention flags, derived SDD status, or ready-to-close metadata; those are read-model fields only.
- [ ] Full unit suite + typecheck green.

**Headless check:** `env -u TMUX npx vitest run test/unit/taskStore.test.ts test/unit/nextTask.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`

**Verify:** `env -u TMUX npx vitest run test/unit/taskStore.test.ts test/unit/nextTask.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`

## Dogfood

**Dogfood:** `env -u TMUX npx vitest run test/unit/nextTask.test.ts -t "claim"`

**Human dogfood:** After implementation ships: create a task via the Bridge from two agents, triage one, have both agents call next_task then race the claim — confirm exactly one wins and the loser re-queries; confirm the sidebar/board data source refreshes.
