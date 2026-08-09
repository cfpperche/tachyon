# 356 — task-journal

_Created 2026-07-04._

**Status:** shipped

**Closure:** shipped 2026-07-04 — implemented per-task append-only `.tachyon/tasks/<id>.journal` storage, `append_task_note`, journal materialization in `get_task`/Task Detail, board `journalCount` boundary, lifecycle/cap/caller tests, and spawn/pin usage guidance.
**Verify:** `npm test -- --run test/unit/taskJournalStore.test.ts test/unit/bridge.test.ts test/unit/boardSnapshot.test.ts`
**Verify:** `npm run typecheck`
**Dogfood:** `npm test -- --run test/unit/taskJournalStore.test.ts`

## Intent

Agents use **pins** as a scratchpad for what they discover while WORKING a task — blockers, decisions,
deviations, findings (e.g. `p-9eb9bd`). That conflates three different things: (1) follow-up WORK → a new
task; (2) an ANNOTATION *about the task being worked* → no home today when the task has no spec, so it leaks
to pins; (3) cross-cutting "worth knowing" → the human's pin. The gap is (2).

This spec gives a Task an **append-only journal**: a running execution log of authored, timestamped entries.
`task.body` is the WHAT (the work's contract, mutable); the journal is the LOG of DOING it; a new task is
discovered follow-up work; a pin is the human's reminder. For a spec-backed task, the spec's `notes.md` is
the DESIGN log (survives the task) and the journal is the EXECUTION log (this instance) — separate.

## Storage: a per-task append LOG, not an embedded array (dueto blocker F1 — the load-bearing correction)

The draft claimed an embedded `notes[]` was "immune to lost updates." **That was false and is corrected
here.** A task is one JSON file; embedding notes means every append rewrites the whole document (temp+rename)
and the in-process mutation lock protects only ONE extension host — a second host, agent process, or manual
edit still races and loses entries. Per-file reduces contention; it does NOT make append atomic.

Therefore the journal is stored as a **per-task append log** — `.tachyon/tasks/<id>.journal` (newline-
delimited JSON, one `JournalEntry` per line), written with **append semantics** (`fs.appendFile` /
`O_APPEND`), never a read-modify-write of a shared array. Appends from independent writers do not clobber
(the OS append is atomic for a single line under the size limits used). `get_task`/Detail materialize the
journal by reading the log. The task's own JSON is untouched by an append (no body/status conflict — dueto
F3 dissolves: journal and task document are different files).

## Acceptance criteria

- [x] **Scenario: append a note** (dueto F2/F7/F11)
  - **When** an agent calls `append_task_note(id, text)` — NO author param (any supplied author is rejected
    `INVALID_ARGUMENT`)
  - **Then** a `JournalEntry {id, ts, author, text}` is appended to `.tachyon/tasks/<id>.journal` via
    append-semantics (not a whole-file rewrite): `id` is store-generated, `ts` comes from the same Tachyon
    time provider used for Task `createdAt`/`updatedAt` (not raw `Date.now`), and `author` is the 351
    **Bridge-resolved caller**. If the caller resolves to a concrete agent/human id, that id is used; a
    LEGACY/unresolvable caller is **rejected `CALLER_REQUIRED`** (blank author is never valid — v1 requires
    a per-agent token; legacy sessions cannot journal). `text` is bounded (per-entry limit). The bridge
    emits `onTasksChanged` with `reason: "journal-appended"` + task id
- [x] **Scenario: concurrent appends + mixed writes don't lose** (dueto F1/F3)
  - **Then** two near-simultaneous appends both survive (append log, not array rewrite); AND a `body`/
    `status` `update_task` racing an `append_task_note` preserves BOTH — they touch different files, so
    neither can overwrite the other (regression test: body edit + note append via separate store instances,
    both survive)
- [x] **Scenario: render, sanitized** (dueto F4)
  - **Then** `get_task` returns the materialized journal; the Task Detail tab (339) renders a chronological
    authored list (escaped author id + display time + text) READ-ONLY below the body; journal text goes
    through the SAME audited sanitize pipeline the 339 body uses (raw HTML never inserted; `javascript:`/
    inline-HTML/`<script>`/malformed-tag regression cases). The board CARD renders NO journal text
- [x] **Scenario: snapshot stays bounded** (dueto F5)
  - **Then** `BoardModel`'s `TaskSummary` carries `journalCount` ONLY — never the journal array or any entry
    text; the board snapshot is built from `TaskSummary`, not a full Task; a test asserts
    `JSON.stringify(snapshot)` contains no entry text and no journal array. The card may show a small
    note-count indicator (like the attachment clip)
- [x] **Scenario: cap rejects, never prunes silently** (dueto F6)
  - **Then** v1 cap policy is REJECT: over the per-entry text limit OR over the max retained journal size,
    `append_task_note` returns `JOURNAL_CAP_EXCEEDED` with current count/bytes — NO automatic drop-oldest
    (an execution log must not shed its earliest blockers). Pruning, if ever added, is an explicit action
    that preserves a durable pruned-count + first/last pruned timestamps, authored `"system"`
- [x] **Scenario: lifecycle** (dueto F8/F12)
  - **Then** the on-disk field is named `journal` everywhere (UI may label it "Notes"); a missing log = an
    empty journal `[]`; appends are allowed in any status EXCEPT terminal cleanup (append to `done` and
    `dropped` is allowed — post-hoc notes are useful; decide in plan if `updatedAt` moves or a separate
    `journalUpdatedAt` does, lean: journal-only change does NOT reorder task lists); the journal SURVIVES
    every transition including `triaged → inbox` reopen and is removed only by hard task deletion (best-
    effort, with the sidecar/attachments)
- [x] **Scenario: usage migration with hard-edged descriptions** (dueto F9/F10)
  - **Then** `append_task_note`'s description says: annotations about a task-in-progress ONLY; it points
    follow-up WORK to `create_task` and human reminders to `create_pin`. `create_pin`'s description points
    task-local scratchpad notes to `append_task_note` when a taskId is known. The spawn brief carries 3
    concrete examples (a blocker → journal; a follow-up → task; a human reminder → pin). Notification: a
    journal append notifies the assignee ONLY when `author != assignee` and the task is active (else no
    human poke in v1); board refresh treats a journal-only change as non-card-content
- [x] Optional/regression: existing tasks (no `.journal` file) load and behave exactly as before

## Non-goals

- No edit/delete of individual entries (append-only; a correction is a new entry).
- No auto-prune in v1 (reject at cap; explicit prune action is a later spec).
- No journal on pins; no auto-migration of existing pins; no merge with a spec's `notes.md`.
- No change to the 325 status/transition model or the 339 authoring contract.
- No author parameter on `append_task_note` (identity is Bridge-resolved, never caller-supplied).

## Open questions

_Resolved in the dueto fold: storage is a per-task append log (not embedded array) — F1; legacy caller is
rejected `CALLER_REQUIRED` — F2; cap REJECTS, no silent prune — F6; field named `journal` — F12. Remaining
for plan: exact max-retained-size + per-entry bound numbers; whether an append moves `updatedAt` or a
separate `journalUpdatedAt` (lean: separate, journal activity doesn't reorder the board); the newline-JSON
log read/parse path for `get_task` (tolerate a torn final line from a crash mid-append)._

## Dogfood (dueto F13)

Run the `t-acbbc2` workflow (or a documented equivalent): record at least one task-local blocker/decision
via `append_task_note`, create NO scratchpad pin for that same information, confirm the Detail tab renders it
safely, and the board snapshot stays bounded (only `journalCount`).
