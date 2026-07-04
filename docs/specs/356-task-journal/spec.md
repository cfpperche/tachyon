# 356 — task-journal

_Created 2026-07-04._

**Status:** draft

## Intent

Agents use **pins** as a scratchpad for what they discover while WORKING a task — blockers, decisions,
deviations, findings (e.g. `p-9eb9bd`, the Excalidraw shell-gap filed against `t-03870f`). That conflates
three genuinely different things: (1) follow-up WORK → already a new task; (2) an ANNOTATION *about the task
being worked* → has no home today when the task has no spec, so it leaks into pins; (3) a cross-cutting
"worth knowing" → the human's pin. The gap is (2).

This spec gives a Task an **append-only journal**: a running execution log of timestamped, authored notes.
The mental model becomes clean — `task.body` is the WHAT (the work's contract, mutable, like a spec's
Intent); the journal is the LOG of DOING it (append-only, authored); a new task is discovered follow-up
work; a pin is the human's reminder. For a spec-backed task, the spec's `notes.md` stays the DESIGN log
(survives the task) while the journal is the EXECUTION log (this instance of doing it) — deliberately
separate.

"Done" means: a task carries a `notes: JournalEntry[]` field; a bridge `append_task_note` tool appends an
entry authored by the 351 Bridge-resolved caller (never a self-declared param); `get_task` and the Task
Detail tab render the journal; and the usage pattern migrates — tool descriptions + the spawn brief steer
agents to journal-on-the-task instead of pinning, so pins shrink to their intended human-reminder purpose.

## Why append-only (the load-bearing decision)

- **Immune to the lost-update class** that `t-0e27a4` documented in `pins.json`: two agents appending never
  clobber each other (unlike a whole-field edit); the store appends, never read-modify-writes the list.
- **Authorship for free via 351**: `append_task_note`'s author is the resolved caller — signed by
  construction, un-spoofable, no author param to guess.
- **Lives WITH the work**: the annotation rides the task through the board and shows in the Detail tab,
  instead of a floating pin someone must correlate back to the task.

## Acceptance criteria

- [ ] **Scenario: append a note**
  - **Given** a task `t-xxxxxx`
  - **When** an agent calls `append_task_note(id, text)`
  - **Then** a `JournalEntry {ts, author, text}` is appended to the task's `notes[]`, `author` is the 351
    Bridge-resolved caller (a passed author param, if any, is validated against the resolved caller like
    every other 351 actor field — mismatch errors), the write is a pure append under the store mutation
    lock (no CAS, no whole-list rewrite), and `onTasksChanged` fires
- [ ] **Scenario: concurrent appends don't lose** (the t-0e27a4 lesson)
  - **Given** two agents append to the same task near-simultaneously
  - **Then** both entries survive (append semantics, not last-writer-wins on the field)
- [ ] **Scenario: body is not the journal**
  - **Then** `task.body` is unchanged by `append_task_note`; the journal is a separate field — editing the
    body never touches notes and appending a note never touches the body
- [ ] **Scenario: render**
  - **Then** `get_task` returns the journal, and the Task Detail tab (spec 339) renders it as a
    chronological authored list (author + relative time + text), read-only, below the body — the board CARD
    does NOT render journal text (bounded card, same discipline as body-not-on-cards, spec 335); an
    optional small note-count indicator on the card is allowed (like the attachment clip)
- [ ] **Scenario: bounded growth**
  - **Then** the journal has an explicit size policy (entry text bound + a max-entries or total-bytes cap
    with documented behavior at the cap — reject, or drop-oldest with a marker — DECIDED IN PLAN); it never
    grows unbounded and never enters the board SNAPSHOT payload uncapped (the snapshot stays a summary; the
    full journal loads via `get_task`/detail, like body)
- [ ] **Scenario: usage migration**
  - **Then** the descriptions of `append_task_note`, `create_pin`, and the spawn-contract brief steer
    agents: annotations about a task-in-progress → the task journal; follow-up WORK → a new task; the
    human's own reminders → pins. Pins stop being the agent scratchpad by convention, not by removal
- [ ] Optional/regression: existing tasks without `notes` load and behave exactly as before (additive field,
  like `body` was to 325).

## Non-goals

- No edit/delete of individual journal entries in v1 (append-only means append-only; correction is a new
  entry). A prune/archive policy at the cap is in scope; per-entry mutation is not.
- No journal on pins (pins keep their rich Tiptap detail; this is a task-only mechanism).
- No auto-migration of existing pins into task journals (the p-9eb9bd-style pins stay; the pattern changes
  going forward).
- No merge of the journal with a spec's `notes.md` — they are separate logs (design vs execution) by
  decision; a spec-backed task may reference its spec, but the journal is not written into `notes.md`.
- No change to the 325 status/transition model or the 339 authoring contract.

## Open questions

- **Cap policy**: max entries vs total bytes; at the cap, reject-new vs drop-oldest-with-marker. (Lean:
  total-bytes cap with drop-oldest + a "[N earlier notes pruned]" marker — a journal should never block a
  write, and the recent log is what matters.)
- **Snapshot exposure**: does the board snapshot carry a note COUNT (for the card indicator) or nothing?
  (Lean: count only — cheap, enables the indicator, no text bloat.)
- **Does `update_task` get a note-append shorthand**, or is `append_task_note` the only path? (Lean:
  separate tool — keeps `update_task`'s field-patch semantics clean and the append CAS-free.)
