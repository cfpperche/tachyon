# 319 — persistence-ledger-retention — notes

_Created 2026-07-01._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Retention runs at append time in the materialized hook writers, avoiding a new scheduler or idle maintenance loop.
- The default window is at most 2000 valid rows, prioritizing the newest row per `agent/event/script` key and then the
  newest tail rows.
- A 256 KiB byte cap is enforced after row selection when possible.
- Compaction writes use temp-file plus rename.
- Malformed/partial lines are tolerated and removed when retention runs.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- None after the plan was drafted.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- Chose max rows plus latest-per-key over max age. Age would introduce clock ambiguity in hooks; row count is
  deterministic and easy to test.
- Chose embedded CommonJS retention in scripts instead of importing Tachyon code so runtime hooks remain standalone.
- Chose hard caps over unlimited latest-per-key preservation after Claude review pointed out that unbounded unique keys
  would undermine the retention guarantee.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- Spec 316 should decide how to present an unusually large key set if many unique agents/scripts keep extra latest rows.
