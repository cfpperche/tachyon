# 463 — claude-canonical-private-fork — notes

_Created 2026-07-26._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Evidence — 2026-07-26

- `npx vitest run test/unit/agentManager.test.ts --reporter=dot`: 416 passed.
- `npm run typecheck`: passed.
- `npm run verify:full:quiet`: passed.
- Same-cwd regression proves copied projections, distinct homes and exact cross-home seed.
- Worktree regression proves independent source/destination home and cwd encoding.
- Failure regression proves cleanup before any destination session remains.
