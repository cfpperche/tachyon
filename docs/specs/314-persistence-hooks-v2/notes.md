# 314 — persistence-hooks-v2 — notes

_Created 2026-07-01._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- 2026-07-02 — Final child-spec decision: 315/317/319/316/318 shipped; 320 canceled as superseded by the existing
  Project Handoff pending-notes lane. The v2 umbrella closes as reliability/observability/settings work, not semantic
  handoff automation.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- Keeping 320 would add `candidate -> pending note -> canonical handoff`. We rejected that extra queue because
  `pending note -> canonical handoff` already provides review before official project state changes.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Verification log

### 2026-07-02T13:25:29Z — pass (1/1) — source: tasks.md
- `test -d docs/specs/315-persistence-stop-hook-dogfood && test -d docs/specs/316-persistence-hook-health-diagnostics && test -d docs/specs/317-persistence-hook-failure-log && test -d docs/specs/318-persistence-settings-ui && test -d docs/specs/319-persistence-ledger-retention && test -d docs/specs/320-persistence-handoff-candidates` — pass
