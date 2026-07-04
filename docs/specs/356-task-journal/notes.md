# 356 — task-journal — notes

_Created 2026-07-04._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Design dueto (probe codex, adversarial-review, 2026-07-04, runId probe-be65532b) — the storage claim collapsed

13 findings (2 blockers). The draft's central claim — "an embedded notes[] array is immune to lost updates"
— was FALSE and the codex correctly demolished it. ALL findings accepted; the fold rewrote the storage model.

- F1 (BLOCKER, the load-bearing one): per-file tasks do NOT make an embedded-array append atomic — it's
  still read-modify-write of the whole JSON, and the in-process lock protects one host only. CORRECTED:
  journal is a per-task APPEND LOG (`.tachyon/tasks/<id>.journal`, newline-JSON, fs.appendFile/O_APPEND) —
  real append semantics, independent writers don't clobber. This also DISSOLVES F3 (body/journal are now
  different files, so update_task and append_task_note can't overwrite each other).
- F2 (BLOCKER): legacy/unresolvable caller → REJECT `CALLER_REQUIRED` (blank author never valid; v1 requires
  a per-agent token — legacy sessions can't journal). Author is Bridge-injected, never a param (F11).
- F6: INVERTED my own lean — drop-oldest destroys the forensic history the feature exists for (the busiest
  task prunes its own early blockers). v1 REJECTS at cap (JOURNAL_CAP_EXCEEDED); prune is a later explicit
  action with durable pruned-count + timestamps.
- F4 explicit sanitization (own XSS path, not inherited); F5 concrete snapshot boundary (TaskSummary carries
  journalCount only, tested via JSON.stringify); F7 {id,ts,author,text} with store id + Tachyon time
  provider; F8 lifecycle (append allowed on done/dropped, survives reopen, removed only by hard delete); F9
  distinct event reason + assignee-only notify; F10 hard-edged tool descriptions + 3 spawn-brief examples;
  F12 field named `journal`; F13 dogfood against t-acbbc2.
Nothing rebutted. The probe earned its keep: it stopped a design that claimed a concurrency guarantee it
did not have — the exact class of bug (t-0e27a4 lost-update) the feature was partly meant to avoid.
