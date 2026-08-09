# 499 — task-attempt-ledger — notes

_Created 2026-08-09._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

### S1 — legacy assignee measurement and backfill recommendation

Measured `/home/goat/tachyon/.tachyon/tasks/*.json` before implementation. The directory contains
1,279 task JSON files (the 2,432 figure in the plan is the count of all task-related files, including
journals), distributed as follows:

| status | has assignee | no assignee |
|---|---:|---:|
| active | 2 | 0 |
| done | 849 | 45 |
| dropped | 11 | 46 |
| inbox | 0 | 85 |
| landed | 191 | 5 |
| triaged | 0 | 45 |

There are 1,051 historical tasks (`landed`, `done`, or `dropped`) carrying an assignee, hence 1,051
candidate terminal attempts; two active tasks carry an assignee, hence two candidate open attempts.
There are 226 tasks with no assignee in total, of which 96 are historical.

Recommendation sent to the owner before S2: backfill one attempt line per legacy assignee. Rejected:
falling back to the legacy field when a task has no ledger, because it would preserve two semantic
sources indefinitely and leave 1,053 real assignments outside the ledger. No backfill is implemented
until the owner answers.

The owner approved the backfill with explicit provenance: historical rows are marked `origin: backfill`,
their evidence says the timestamp is inferred, and `inferredFromUpdatedAt` names its source without claiming
that it was an observed claim time. The three measured groups map to 1,051 inferred delivered events, two
inferred open claims, and no event for the 226 tasks without an assignee. Existing `.attempts` files are never
touched, and the idempotence test proves a second pass adds nothing.

### Visual QA

Anchor: a historical Board card must continue to read `delivered by <agent>` without changing the existing
card layout. Verdict: **pass**. The real Board preview was captured before and after at 880×900 and 360×800;
both accessibility snapshots identify the done card as `delivered by claude`, and the after snapshot also
identifies the deliberately long landed deliverer. Card spacing, type, color treatment, and the existing
horizontal narrow-width layout did not change. Evidence record: `ev-2026-08-09T14:44:09.498Z-0`.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
