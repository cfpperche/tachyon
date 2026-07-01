# 309 — continuity-nudge-episode-anchor — notes

_Created 2026-07-01._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Root cause confirmed from code and local state: `maybeRemindCheckpoint` used only `lastNudgeAt` with a 15-minute
  cooldown, so a declared agent with no continuity brief could be reminded forever while idle.
- Use `lastNudgeSeq` as the durable episode anchor. This mirrors the handoff nudge pattern, but stores the anchor in
  continuity state because continuity already has per-agent persisted bookkeeping.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- None currently.

## Verification log

### 2026-07-01T12:32:34Z — pass (1/1) — source: tasks.md
- `npm test -- --run test/unit/continuityWiring.test.ts test/unit/continuityClassifier.test.ts && npm run typecheck` — pass

## Dogfood log

### 2026-07-01T12:32:41Z — pass (1/1) — source: tasks.md — commit: ddccd9a22e31e01c870a32b86b96ad010a8ef3a1
- `npm test -- --run test/unit/continuityWiring.test.ts -t "spec 309"` — pass
