# 499 — plan

_Created 2026-08-09. Ratified by the maintainer._

## Approach

One new per-task file holds attempts. `TaskStore` derives two named values from it and stops treating
`assignee` as a field that means two things.

Nothing about the shape is invented: `.tachyon/tasks/` already holds `<id>.json` (write+rename) and
`<id>.journal` (JSONL append). The ledger is `<id>.attempts`, JSONL append, same directory, same
per-task convention — so a task's history moves and deletes with the task, like everything else about it.

## Decisions

### D1 — the ledger is `<id>.attempts`, JSONL, one line per attempt event

**Rejected: widening the existing journal.** Measured, three reasons: it appends only on status change
(`TaskStore.ts:327`), so a re-claim leaves no trace; `JournalEntry` is `{id, ts, author, text}`
(`types.ts:52-57`) with no typed link between an attempt's start and end; and `JOURNAL_MAX_BYTES`
refuses the append at 256 KiB (`TaskJournalStore.ts:7`). **The cap is not theoretical — the largest
journal in this workspace is 153 854 bytes, 60% of it.**

**Rejected: one global stream.** A task's attempts belong to the task. A global file makes deleting a
task leave orphans and makes every read scan foreign rows.

**Rejected: a database.** 2 432 files in `.tachyon/tasks/` work today. Introducing a second storage
engine for a few hundred rows is not justified by anything measured.

### D2 — an attempt has one beginning and at most one ending, and "ended" is not "failed"

Events the store can actually observe, and no others:

| event | when | who writes it |
|---|---|---|
| `claimed` | a claim transaction succeeds | `TaskStore` |
| `released` | any of the five lifecycle paths from `t-49d7ec` | `TaskStore` |
| `delivered` | the task reaches `landed`/`done` while this attempt is open | `TaskStore` |
| `dropped` | the task reaches `dropped` while this attempt is open | `TaskStore` |

**`released` is not a verdict**, and this is the whole lesson of `t-49d7ec`: process loss proves only
that nobody is executing. An attempt that ends `released` says exactly that and nothing more.

An attempt with no ending is **open**. There is at most one open attempt per task, and that invariant
is what makes `currentAssignee` well-defined.

### D3 — two derived values, computed at read time, never persisted

- `currentAssignee` — the agent of the open attempt, or none.
- `lastDeliverer` — the agent of the most recent attempt that ended `delivered`.

**Never written into the task file.** The spec's reasoning: the journal is `appendFileSync`
(`TaskJournalStore.ts:200`) and the task is write+rename (`TaskStore.ts:513-518`), two files with no
shared transaction; `withMutation` (`TaskStore.ts:614-623`) serialises only in-process. A persisted
derivation would drift on a crash between the two writes. Computed at read, it cannot.

### D4 — `assignee` becomes a read-time alias of `currentAssignee`, and the deliverer consumers migrate

`.assignee` is read 101 times in 35 files. Most of them mean "who is executing" and keep working
unchanged through the alias. The ones that mean "who delivered" migrate to `lastDeliverer`:

- `boardModel.ts:313-316` — `assigneeLabel` renders `delivered by ${task.assignee}` for
  `HISTORICAL_ASSIGNEE_STATUSES` (`:180`), and `assigneeHistorical` at `:211`
- `EvolutionCoordinator.ts:60-63` — `completionMarker` reads `event.after.assignee` at the transition
  to `done`
- `EvolutionCoordinator.ts:85` — `reconcileCompletedTasks` compares `task.assignee !== marker.agent`
- `EvolutionCoordinator.ts:87` — `ensureReview` resolves the reviewer

That list is the migration. It is short because the second meaning only ever mattered in two places.

### D5 — no retention rule, and it is measured rather than assumed

An attempt record is a claim, not an event stream: ~200 bytes, and **42 tasks in this project's entire
history have ever had ownership released**. Worst case is kilobytes per task. A cap would be
ceremony — and a refusing cap is exactly what makes the current journal unable to hold a counter.

If this is ever wrong, the file is JSONL and truncation is a later decision with real data behind it.

### D6 — no migrator

`assignee` on existing tasks is the deliverer for historical ones and the executor for open ones.
**Measure `.tachyon/tasks/*.json` before writing anything**: if a status is historical and `assignee`
is set, that is a delivered attempt and can be backfilled as one line; if it is `active`, it is an open
attempt. This is a backfill of ~2 400 files, not a migration format — and it may be simpler to derive
`lastDeliverer` with a fallback to the legacy field for tasks with no ledger.

Decide it against the measurement, in S1, and record which.

## Files touched

- new: `src/tasks/TaskAttemptStore.ts`, `test/unit/taskAttemptStore.test.ts`
- `src/tasks/types.ts` — attempt types; the `assignee` doc comment, again
- `src/tasks/TaskStore.ts` — write attempts in the claim/release/terminal paths; expose the two derived values
- `src/tasks/boardModel.ts` — `assigneeLabel`, `assigneeHistorical`
- `src/evolution/EvolutionCoordinator.ts` — four sites
- tests for each

## Risks

- **The backfill is the dangerous half, not the ledger.** Getting `lastDeliverer` wrong silently turns
  off self-evolution — the exact failure the spec's rejected v1 would have caused. Every acceptance
  scenario about Evolution must fail before it passes.
- **Two writers, one task.** Attempt append and task write are still two files. The invariant "at most
  one open attempt" must hold after a crash between them. Prove it with a test that appends then
  simulates the task write failing.
- **`withMutation` is in-process only.** Two Tachyon windows on one workspace can interleave. This is
  pre-existing and not made worse here, but the ledger must not assume exclusivity it does not have.
