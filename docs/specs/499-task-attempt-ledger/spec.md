# 499 — task-attempt-ledger

_Created 2026-08-09._

**Status:** shipped

**Closure:** Attempts live in `.tachyon/tasks/<id>.attempts` (JSONL, no refusing cap). `TaskStore`
**Verify:** `npm run verify:full:quiet`
derives `currentAssignee` and `lastDeliverer` at read time and persists neither; `boardModel`'s
`delivered by` and Evolution's four sites read the delivered value. 1 051 historical assignees were
backfilled as `delivered` attempts, marked as backfill rather than carrying an invented timestamp.
Merged in `fc3be5cb`.

<!-- The maintainer owns the intent; this is a transcription awaiting ratification.
     The measurements below were taken before writing, and the central one killed the
     first version of this proposal. Read § "What was already tried and refused". -->

## Intent

A Task carries `assignee?: string` — one name, overwritten on every claim. The board therefore cannot
answer three questions it should be able to answer:

- who has already tried this?
- how did each attempt end?
- how many times has it failed?

None of them is a nice-to-have. The third is what a circuit breaker needs, and without it a task can
be handed to a replacement forever with nobody noticing.

**This spec replaces the single overwritten field with an append-only record of attempts, and derives
what the product needs from it.**

### The thing that makes this non-trivial, measured

`assignee` does not mean one thing. It means two, selected by status:

| status | what the field means |
|---|---|
| `triaged`, `active` | who is executing now (`ASSIGNEE_EDITABLE_STATUSES`, `boardModel.ts:181`) |
| `landed`, `done`, `dropped` | **who delivered it** (`HISTORICAL_ASSIGNEE_STATUSES`, `boardModel.ts:180`) |

The second meaning is not decoration. `boardModel.ts:316` renders `delivered by ${task.assignee}`,
and `EvolutionCoordinator` hangs the entire self-review chain off it: `completionMarker` reads
`event.after.assignee` at the moment a task becomes `done` (`:60-63`), `reconcileCompletedTasks`
refuses when `task.assignee !== marker.agent` (`:85`), and `ensureReview` resolves the reviewer the
same way (`:87`).

So the field survives completion on purpose, and something depends on that.

### What was already tried and refused

The first version of this proposal said: keep `task.assignee` as a derived, read-only projection of
the **live claim**, so that the 101 read sites in 35 files need not change.

**An adversarial review measured it and killed it, and the reason is semantic, not mechanical.** A
projection of the live claim is empty once the attempt ends. That would erase `delivered by` from
every historical card and silently disable self-evolution — while preserving the field's *shape*, so
it would pass both the type checker and a grep.

A second, independent objection stands on its own: if `assignee` stays **persisted** as a cache of the
ledger, there are two sources with no shared transaction. The journal is `appendFileSync`
(`TaskJournalStore.ts:183-201`); the task is a separate file written with write+rename
(`TaskStore.ts:513-518`); `withMutation` (`TaskStore.ts:614-623`) serialises only within this process.
A failure between the two writes leaves the ledger and its "projection" disagreeing. A projection is
only honest when it is **computed at read time from a single source**.

### Why the existing journal is not already the answer

It was proposed and refused, on three measurements:

1. `update` appends only when the **status** changes (`TaskStore.ts:327`). A re-claim `active → active`
   swaps the assignee and leaves no entry at all.
2. Release is special-cased prose (`TaskStore.ts:354-370`) with no attempt id and no typed link
   between an attempt's start and its end. `JournalEntry` is `{id, ts, author, text}`
   (`types.ts:52-57`).
3. `JOURNAL_MAX_BYTES = 256 KiB` with a refusing append (`TaskJournalStore.ts:7`). It cannot carry an
   unbounded attempt history, and a failure counter that can be refused is not a counter.

## Acceptance criteria

- [ ] **Scenario: the board still says who delivered**
  - **Given** a task that reached `done` with an attempt that delivered it
  - **When** the card is rendered
  - **Then** it still reads `delivered by <agent>`, sourced from the attempt record rather than from a
    field that happens to have survived

- [ ] **Scenario: self-evolution still fires**
  - **Given** a task moving to `done` whose delivering agent declares `selfEvolution.enabled`
  - **When** the completion marker is minted
  - **Then** the reviewer resolved is the agent that delivered, and reconcile still refuses when the
    marker disagrees with the record

- [ ] **Scenario: a re-claim is recorded**
  - **Given** an `active` task whose executor was released
  - **When** a replacement claims it
  - **Then** the ledger holds two attempts, and the first one's ending is named — today this transition
    writes nothing at all

- [ ] **Scenario: two questions, two answers**
  - **Given** any task
  - **When** the product asks who is executing now, and separately who delivered it
  - **Then** those are two distinct derived values, and a task can legitimately have the second without
    the first

- [ ] **Scenario: failure is countable**
  - **Given** a task whose attempts have ended without delivery
  - **When** the count is read
  - **Then** it reflects every attempt, and a new attempt cannot reset it

- [ ] **Scenario: the derived value cannot drift**
  - **Given** a crash between any two writes
  - **When** the product restarts
  - **Then** no derived owner disagrees with the ledger, because none was persisted separately

- [ ] `assignee` is never written as a cache of the ledger. If it survives at all it is a read-time
      alias of "executing now", and its removal is a rename, not a data migration.
- [ ] Consumers that meant "who delivered" read the delivered value; consumers that meant "who is on
      it" read the current one. No consumer keeps reading one field for both.

## Non-goals

- **Removing `active` from the status enum.** `active` without an owner is deliberately claimable
  (`nextTask.ts:28-32`) and means work selected for execution with nobody executing
  (`types.ts:173-175`). Removing it would force either lying with `triaged` again — the defect
  `t-49d7ec` just fixed — or inventing an equivalent state. Orca does not derive it either.
- **Copying Orca's three tables.** Their `dispatch_contexts` / `worker_dispatches` split is where the
  idea comes from (`docs/research/orca-orchestration-task-lifecycle-land.md`), not a shape to
  reproduce. Their process axis already exists here, in the agent roster.
- **Touching all 101 read sites.** Only the ones that meant "who delivered" change meaning; the rest
  keep reading "who is executing" under whatever name it ends up with.
- **A migrator for historical claims.** This workspace is the only one that exists. Measure what is on
  disk before writing any migration; if the state is not there, it is nowhere.
- **Retrying, scheduling, or circuit-breaking on the count.** This spec makes failure *countable*.
  Acting on the count is a separate decision that nobody has made.

## Open questions

1. **Where does the ledger live?** `TaskStore` is one JSON file per task plus a per-task journal. A
   third file per task, a widened journal, or a single stream — each has a different failure mode, and
   the 256 KiB refusing cap is the reason the current journal cannot simply be widened.
2. **What ends an attempt, and who says so?** Delivery is not observed by the store today; `t-49d7ec`
   established that process death proves only that nobody is executing. An attempt that ends without a
   verdict is the common case and must be representable.
3. **Retention.** Attempts accumulate. The journal answered this with a byte cap that refuses; a
   counter that can be refused is not a counter, so this needs a different answer.
