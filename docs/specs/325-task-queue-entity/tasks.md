# 325 — task-queue-entity — tasks

_Generated from `plan.md` on 2026-07-02. NOT started — awaiting the maintainer's go (spec-first delivery)._

## Implementation

- [ ] `src/tasks/types.ts`: `Task` + status enum + the mutability/transition tables as typed constants.
- [ ] `src/tasks/TaskStore.ts`: per-task files in `.tachyon/tasks/` — create via tmp+`linkSync` (EEXIST ⇒ re-mint id), update via tmp+rename under a per-store async mutex with CAS preconditions; `list()` dir-scan ignoring `*.tmp.*`, skipping corrupt JSON with structured warnings.
- [ ] `src/tasks/nextTask.ts`: pure selection (two tiers, dependency-aware exclusion, priority→age→id, structured empty reasons).
- [ ] `src/bridge/tools.ts`: `create_task` / `get_task` / `update_task` (with `expect` CAS) / `list_tasks` (bounded, no body) / `next_task` — pin-block conventions, `onViewsChanged("tasks")`.
- [ ] `src/workspace/Workspace.ts`: construct + expose the store.
- [ ] Spec-stage derivation helper for `spec_ref` (reads `**Status:**`, maps superseded/abandoned/deferred to attention flags).

## Verification

- [ ] TaskStore: exclusive create (concurrent same-id ⇒ one wins, one re-mints); CAS claim (two claimers ⇒ one `precondition-failed`); corrupt/tmp files never listed; mutability/transition table enforced fail-closed.
- [ ] nextTask: dependency exclusion (both tiers), dangling dep resolved, tier policy, ordering, all three empty reasons.
- [ ] Bridge: validation bounds (trim/non-empty/code-points/priority/status/deps), bounded list + get_task, author defaulting mirrors pins.
- [ ] Full unit suite + typecheck green.

**Headless check:** `env -u TMUX npx vitest run test/unit/taskStore.test.ts test/unit/nextTask.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`

**Verify:** `env -u TMUX npx vitest run test/unit/taskStore.test.ts test/unit/nextTask.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`

## Dogfood

**Dogfood:** `env -u TMUX npx vitest run test/unit/nextTask.test.ts -t "claim"`

**Human dogfood:** After implementation ships: create a task via the Bridge from two agents, triage one, have both agents call next_task then race the claim — confirm exactly one wins and the loser re-queries; confirm the sidebar/board data source refreshes.
