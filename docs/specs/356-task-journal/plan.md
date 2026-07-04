# 356 — task-journal — plan

_Drafted 2026-07-04 (post-dueto). The load-bearing correction: journal is a per-task APPEND LOG file, NOT an
embedded array — an embedded array is read-modify-write and loses concurrent appends (dueto F1). Everything
serves that + un-spoofable authorship (351) + bounded/sanitized surfacing._

## Approach

1. **Storage — `src/tasks/TaskJournalStore.ts` (new)**: journal lives at `.tachyon/tasks/<id>.journal`,
   newline-delimited JSON (one `JournalEntry {id, ts, author, text}` per line). Append via `fs.appendFile`
   (O_APPEND) — a single line under the size cap is an atomic OS append, so independent writers (two hosts,
   agent + edit) don't clobber. This is SEPARATE from TaskStore's per-task JSON — an append never rewrites
   the task document (dissolves F3: body/status edits and note appends touch different files). Read/
   materialize tolerates a torn final line (crash mid-append) by skipping an unparseable last line. `id` is
   store-minted; `ts` from the SAME time provider TaskStore uses for createdAt/updatedAt (not raw Date.now).
2. **Bridge tool — `append_task_note(id, text)` in tools.ts**: NO author param (supplied author →
   INVALID_ARGUMENT). author = the 351 resolved caller (deps.caller); a legacy/unresolvable caller →
   `CALLER_REQUIRED` (blank author never valid). Per-entry text bound; over the per-entry limit OR the max
   retained journal size → `JOURNAL_CAP_EXCEEDED` (reject, NO drop-oldest). Emits onTasksChanged with
   reason:"journal-appended". Assignee notify ONLY when author != assignee AND task active (else no v1 poke).
3. **get_task + TaskDetail (339)**: get_task materializes the journal (reads the log). The Detail tab renders
   a chronological authored list (escaped author + display time + text) read-only below the body, through
   the SAME audited sanitize pipeline the 339 body uses (raw HTML never inserted). Board CARD renders no
   journal text.
4. **Board snapshot boundary**: BoardModel TaskSummary gains `journalCount` ONLY (never the array/text);
   snapshot built from TaskSummary; a test asserts JSON.stringify(snapshot) has no entry text / no journal
   array. Card may show a small note-count indicator (like the attachment clip).
5. **Lifecycle**: field named `journal` on disk (UI labels "Notes"); missing log = []; append allowed in any
   status incl. done/dropped; journal SURVIVES all transitions incl. triaged→inbox reopen; removed only by
   hard task delete (best-effort, with sidecar/attachments). Journal-only change does NOT move task.updatedAt
   (a separate journalUpdatedAt or none — lean: none in v1, don't reorder the board on a note).
6. **Usage migration**: hard-edged tool descriptions (append_task_note → annotations only, points follow-up
   to create_task + reminders to create_pin; create_pin → points task-local notes to append_task_note when
   taskId known); 3 concrete examples in the spawn brief (blocker→journal, follow-up→task, reminder→pin).

## Key decisions

- Append LOG file, not embedded array (dueto F1) — the ONLY design that earns the concurrent-append claim.
- Reject at cap, never silent drop-oldest (dueto F6) — an execution log must not shed its earliest blockers.
- No author param; legacy caller rejected (dueto F2/F11) — authorship is Bridge-resolved or it doesn't happen.
- Journal excluded from the snapshot by construction (built from TaskSummary), count only (dueto F5).

## Files touched

- src/tasks/TaskJournalStore.ts (new) + types (JournalEntry).
- src/bridge/tools.ts (append_task_note + description edits to create_pin; caller-resolved author).
- src/tasks/boardSnapshot.ts / boardModel.ts (journalCount on TaskSummary, snapshot exclusion test).
- src/webview/task-detail/* (render the journal, sanitized; card note-count indicator).
- src/bridge/spawnContract.ts (3 usage examples in the brief).
- get_task path (materialize journal).
- Tests: append log concurrency, legacy-caller reject, cap reject, sanitization XSS cases, snapshot-exclusion,
  lifecycle (append on done/dropped, survives reopen), body-edit + note-append both survive.

## Risks

- TaskStore is 325 (shipped) — the journal is a SEPARATE store; do not add notes to the task JSON. Touching
  TaskStore's write path risks the 325 contract; the journal store is standalone.
- tools.ts is the 341/348/351 hot path — append_task_note is a NEW tool, don't disturb existing handlers;
  reuse deps.caller (351) exactly as update_task's self-assign path does.
- task-detail is being watched by the 350 Phase 2 work (taskStudioMig) — but that's task-STUDIO, not
  task-DETAIL; still, git status before every commit.

## Sources consulted

spec 356 post-dueto + notes (probe-be65532b) · 325 TaskStore (per-file, mutation lock, time provider) · 351
callerIdentity (deps.caller resolution) · 339 TaskDetailPanel (body sanitize pipeline) · 335 boardSnapshot/
boardModel (TaskSummary bounded) · t-0e27a4 (the lost-update lesson that forced the log design).
