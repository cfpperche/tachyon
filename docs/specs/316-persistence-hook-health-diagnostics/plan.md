# 316 — persistence-hook-health-diagnostics — plan

_Drafted from `spec.md` on 2026-07-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

Not drafted yet. This spec should be planned after the failure-log and retention contracts are clear enough to provide
durable health signals.

## Key decisions

Pending. The plan must choose the first UI surface and define the state model.

## Files touched

Pending.

## Risks & unknowns

Pending. Highest risk: reporting hook health from desired config instead of actual current-spawn evidence.

## Sources consulted

- `docs/specs/312-silent-persistence-hooks/`
- `docs/specs/314-persistence-hooks-v2/`
- `docs/specs/317-persistence-hook-failure-log/`
- `docs/specs/319-persistence-ledger-retention/`
- `src/workspace/Workspace.ts`
- `src/webview/inspector/App.tsx`
- `src/webview/sidebar/App.tsx`
