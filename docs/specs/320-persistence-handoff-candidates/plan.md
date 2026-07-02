# 320 — persistence-handoff-candidates — plan

_Drafted from `spec.md` on 2026-07-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

Do not implement. The proposed candidate lane overlaps with the Project Handoff pending-notes lane that already exists:
agents append candidate project-state updates with `append_project_handoff_note`, those notes stay separate from the
canonical handoff, and the owner/human distills them later.

## Key decisions

- Cancel as `superseded`, not `deferred`: there is no missing prerequisite; the current product surface already covers
  the review-gated buffer.
- Do not create automatic candidates from Stop hooks, health diagnostics, or activity ledgers. That would reintroduce
  noise without a clear action boundary.
- Future work, if needed, should improve pending-note triage/distillation in the existing Project Handoff panel.

## Files touched

- `docs/specs/320-persistence-handoff-candidates/*` — cancellation decision.
- `docs/specs/314-persistence-hooks-v2/*` — umbrella closure updated.

## Risks & unknowns

- The original motivation was legitimate: avoid missing project-state updates. The corrected path is to refine
  explicit pending-note UX, not add a second pre-pending queue.
- If future evidence shows agents overuse `append_project_handoff_note`, handle that as pending-note quality/filtering,
  not candidate generation.

## Sources consulted

- `docs/specs/314-persistence-hooks-v2/`
- `docs/specs/319-persistence-ledger-retention/`
- `src/webview/HandoffPanel.ts`
- `src/webview/handoff/App.tsx`
