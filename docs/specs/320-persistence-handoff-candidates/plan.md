# 320 — persistence-handoff-candidates — plan

_Drafted from `spec.md` on 2026-07-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

Not drafted yet. Treat this as a later follow-up unless the owner explicitly wants semantic handoff candidates to remain
inside the persistence-hooks v2 reliability arc.

## Key decisions

Pending. The plan must choose deterministic candidate rules, bounded probe assistance, or explicit opt-in commands.

## Files touched

Pending.

## Risks & unknowns

Pending. Highest risk: recreating human-visible noise or false project state.

## Sources consulted

- `docs/specs/314-persistence-hooks-v2/`
- `docs/specs/319-persistence-ledger-retention/`
- `src/webview/HandoffPanel.ts`
- `src/webview/handoff/App.tsx`
