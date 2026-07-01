# 319 — persistence-ledger-retention — plan

_Drafted from `spec.md` on 2026-07-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

Not drafted yet. This should be planned before broad diagnostics/UI rollout and after the failure-log schema is known.

## Key decisions

Pending. The plan must choose max rows, max bytes, max age, or a hybrid retention rule.

## Files touched

Pending.

## Risks & unknowns

Pending. Highest risk: pruning the latest evidence per agent/event or keeping sensitive diagnostics too long.

## Sources consulted

- `docs/specs/312-silent-persistence-hooks/`
- `docs/specs/317-persistence-hook-failure-log/`
- `docs/specs/320-persistence-handoff-candidates/`
- `src/activity/sessionOwners.ts`
- `src/activity/logStore.ts`
