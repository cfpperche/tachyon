# 437 — agent-profile-bundle — notes

_Created 2026-07-22._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- Probe review is incorporated as a minimal boundary: closed allowlist, one JSON file, exact V1 only, no archive, no heuristic redaction, no migration graph, and clone via identical bytes.
- Portable runtime means authored adapter/executable/model preferences only; runtime projections, sessions, homes and memory remain excluded.
- Environment values are excluded wholesale because the stored schema has no explicit “safe to export” classification.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

None.

## Dogfood log

### 2026-07-23T00:07:48Z — pass (1/1) — source: tasks.md — commit: f09fc2327003adf10ff7c23afdf0f57a431b218c
- `npx vitest run test/unit/agentProfileBundle.test.ts test/unit/workspaceHeadless.test.ts` — pass
