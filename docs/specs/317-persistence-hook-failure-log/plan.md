# 317 — persistence-hook-failure-log — plan

_Drafted from `spec.md` on 2026-07-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

Not drafted yet. This is the first reliability implementation candidate after 315 if the owner accepts the revised
observability-first sequence.

## Key decisions

Pending. The plan must settle the JSONL schema and failure-swallowing contract.

## Files touched

Pending.

## Risks & unknowns

Pending. Highest risk: logging too much hook stdin or making hook failure visible to the runtime/user.

## Sources consulted

- `docs/specs/312-silent-persistence-hooks/`
- `docs/specs/314-persistence-hooks-v2/`
- `src/activity/sessionOwners.ts`
- `src/harness/HarnessManager.ts`
- `test/unit/sessionOwners.test.ts`
