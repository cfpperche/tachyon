# 315 — persistence-stop-hook-dogfood — plan

_Drafted from `spec.md` on 2026-07-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

Not drafted yet. Before planning, re-read `spec.md`, `docs/specs/314-persistence-hooks-v2/plan.md`, and the current
runtime hook materialization code.

## Key decisions

Pending. The plan must decide whether proof is fully headless or includes a small documented manual step per runtime.

## Files touched

Pending.

## Risks & unknowns

Pending. Highest risk: claiming Stop success without proving the runtime fired the hook.

## Sources consulted

- `docs/specs/312-silent-persistence-hooks/`
- `docs/specs/314-persistence-hooks-v2/`
- `src/activity/sessionOwners.ts`
- `src/harness/HarnessManager.ts`
- `src/agents/AgentManager.ts`
- `src/workspace/Workspace.ts`
