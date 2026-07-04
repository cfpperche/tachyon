# 356 — task-journal — tasks

_Generated 2026-07-04. THE INVARIANT: journal is a per-task APPEND LOG file, never an embedded array (dueto
F1 — an array append is read-modify-write and loses concurrent writers). Commit per task by pathspec. 350
Phase 2 (taskStudioMig) works task-STUDIO in parallel — disjoint from task-DETAIL/tasks-store/tools here, but
git status before every commit._

## Implementation

- [ ] T1 TaskJournalStore (new): `.tachyon/tasks/<id>.journal` newline-JSON, append via fs.appendFile
  (O_APPEND); JournalEntry{id,ts,author,text} (store-minted id, Tachyon time provider ts); materialize
  tolerating a torn final line; per-entry + max-size caps. Tests: two independent appends both survive; torn
  line skipped; cap → error.
- [ ] T2 append_task_note bridge tool: NO author param (supplied → INVALID_ARGUMENT); author = 351 resolved
  caller, legacy/unresolvable → CALLER_REQUIRED; JOURNAL_CAP_EXCEEDED on cap; onTasksChanged
  reason:"journal-appended"; assignee notify only when author!=assignee && active. Tests incl. legacy reject.
- [ ] T3 get_task materializes journal; TaskDetail (339) renders chronological authored list (escaped) via
  the 339 body sanitize pipeline, read-only, below body; XSS regression cases (<script>, javascript: link,
  inline HTML, malformed). Board card: no journal text.
- [ ] T4 Snapshot boundary: TaskSummary gains journalCount ONLY; snapshot from TaskSummary; test asserts
  JSON.stringify(snapshot) has no entry text / no journal array. Card note-count indicator.
- [ ] T5 Lifecycle + migration: field `journal`; missing=[]; append allowed all statuses incl. done/dropped;
  survives triaged→inbox; removed only by hard delete; journal-only change does not reorder the board.
  Hard-edged descriptions (append_task_note / create_pin) + 3 spawn-brief examples. Full suite + typechecks.

## Verification

- [ ] Concurrent appends + body-edit-vs-append both survive (different files) — T1/T2 tests.
- [ ] Legacy caller rejected CALLER_REQUIRED; no author param honored — T2.
- [ ] Cap rejects (JOURNAL_CAP_EXCEEDED), never drops — T1/T2.
- [ ] Journal text sanitized in Detail (XSS cases) — T3.
- [ ] Snapshot carries journalCount only, no text (JSON.stringify assertion) — T4.
- [ ] Survives reopen; append on done/dropped ok — T5.
- [ ] npm test + both typechecks green.

**Headless check:** `npm test -- --run test/unit/taskJournalStore.test.ts test/unit/bridge.test.ts test/unit/boardSnapshot.test.ts && npm run typecheck`

**Verify:** `npm test -- --run test/unit/taskJournalStore.test.ts test/unit/bridge.test.ts test/unit/boardSnapshot.test.ts`
**Verify:** `npm run typecheck`

## Dogfood

**Dogfood:** `npm test -- --run test/unit/taskJournalStore.test.ts`
<!-- The append-log concurrency + cap tests ARE the contract. The lived workflow is the human pass below. -->

**Human dogfood (dueto F13):** the t-acbbc2 workflow — record a task-local blocker/decision via
append_task_note, create NO scratchpad pin for it, confirm the Detail tab renders it safely, the board
snapshot stays bounded (journalCount only), and a legacy pre-351 session is rejected when it tries to append.

## Visual QA

- [ ] Evidence: Task Detail with a rendered journal (author + time + text), + the card note-count indicator.
- [ ] Verdict:
