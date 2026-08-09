# 499 — tasks

_Created 2026-08-09._

**Verify:** `npm run verify:full:quiet`

Ordered. Each slice leaves `main` green on its own. S3 is the one that can silently break the product,
so its red comes first and is non-negotiable.

## S1 — measure, then decide the backfill

- [ ] Count `.tachyon/tasks/*.json` by (status, has-assignee). This decides D6 and nothing else should
      be written before it exists.
- [ ] Record in `notes.md`: how many historical tasks carry an assignee (candidate delivered attempts),
      how many `active` ones do (candidate open attempts), and how many carry none.
- [ ] Decide and record: backfill one line per legacy assignee, **or** derive `lastDeliverer` with a
      fallback to the legacy field when a task has no ledger. Name the one you rejected.

## S2 — the ledger exists and nothing uses it

- [ ] Red first: append two attempts for a task and read them back; fails because the store does not exist.
- [ ] `TaskAttemptStore`: `<id>.attempts`, JSONL append, same directory convention as the journal.
- [ ] Typed events: `claimed`, `released`, `delivered`, `dropped`, each carrying agent, timestamp and
      the evidence string the lifecycle already produces.
- [ ] **No byte cap that refuses.** D5 says why; if you add one anyway, say why in the commit.
- [ ] Invariant, held by test: at most one open attempt per task. A second `claimed` with one open is a
      refusal that names the open one.

## S3 — the two derived values, and the consumers that meant "delivered"

- [ ] Red first, and this is the slice's whole point: a test proving that a `done` task still yields its
      deliverer, and that Evolution's completion marker still resolves the delivering agent. Write it
      against `lastDeliverer` so it fails now.
- [ ] `currentAssignee` and `lastDeliverer` derived at read time in `TaskStore`. Neither is written to
      the task file — a test asserts the task JSON on disk gains no field.
- [ ] Migrate the four Evolution sites (`EvolutionCoordinator.ts:60-63`, `:85`, `:87`) to `lastDeliverer`.
- [ ] Migrate `boardModel.ts:313-316` (`assigneeLabel`) and `:211` (`assigneeHistorical`).
- [ ] `assignee` becomes a read-time alias of `currentAssignee`. The other ~95 read sites are untouched
      — if a change needs them, stop and re-read plan.md § D4.

## S4 — the lifecycle writes attempts

- [ ] Claim paths append `claimed`: `update` with an assignee, and `spawn_agent(claim_task:)`.
- [ ] `returnUnavailableAgentClaims` appends `released` with the evidence string it already builds
      (`TaskStore.ts:354-370`), for all five call sites.
- [ ] Reaching `landed`/`done` with an open attempt appends `delivered`; `dropped` appends `dropped`.
- [ ] Red first: a re-claim `active → active` produces two attempts. **Today this writes nothing at
      all** (`TaskStore.ts:327` appends only on status change) — that gap is why this spec exists.
- [ ] Crash safety: a test where the attempt append succeeds and the task write fails leaves at most one
      open attempt.

## S5 — the question that could not be asked

- [ ] `TaskStore` answers "attempts that ended without delivery" for a task.
- [ ] A new attempt cannot reset it — the count comes from the ledger, never from a field.
- [ ] **Do not act on the count.** No retry, no scheduling, no circuit breaker. spec.md § Non-goals:
      making failure countable is this spec; deciding what to do about it is nobody's decision yet.

## Visual QA

- [ ] The board card for a historical task still reads `delivered by <agent>`.
- [ ] Evidence: screenshot of a `done` card before and after.
- [ ] Verdict: recorded after looking, including anything fixed as a result.
