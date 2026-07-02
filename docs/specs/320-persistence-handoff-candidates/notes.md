# 320 — persistence-handoff-candidates — notes

_Created 2026-07-01._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- 2026-07-02 — Owner canceled this spec after comparing it with the live Project Handoff panel: pending notes already
  provide a review-gated lane separate from the canonical handoff. A second candidate queue would duplicate that model.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- Giving up automatic candidate generation avoids another queue and avoids recreating noisy persistence behavior. The
  cost is that agents must still explicitly call `append_project_handoff_note` when they know project state changed.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Verification log

### 2026-07-02T13:24:07Z — fail (0/1) — source: tasks.md
- `test "$(rg -n '^\\*\\*Status:\\*\\* superseded' docs/specs/320-persistence-handoff-candidates/spec.md | wc -l)" -eq 1` — fail

### 2026-07-02T13:25:29Z — pass (1/1) — source: tasks.md
- `grep -Fq '**Status:** superseded' docs/specs/320-persistence-handoff-candidates/spec.md` — pass
