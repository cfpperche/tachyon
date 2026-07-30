# 483 — governed Saved Agent proposal v2 — notes

## Design decisions

- 2026-07-30 — Keep the original strict creation action and add v2. This is the same skew-safe rule
  established after the 0.56.110 incident.
- 2026-07-30 — `top-level` is roster ownership only; it does not erase runtime lineage or make an
  agent a coordinator by inference.
- 2026-07-30 — A requested proposal grant remains proposal-only: every descendant request still waits
  for an independent human approval.

## Deviations

None.

## Tradeoffs

The prior approved `claude-coordinator` state is not silently repaired. A fresh proposal is required
after the release because the original human review did not include the v2 choices.

## Open questions

None.

## Closure

- Focused proposal/lifecycle tests: 97 passed.
- Typecheck: passed.
- Full gate: recorded on the final committed tree.
- Visual QA remains an explicit opt-out: the change adds factual rows to the existing review layout;
  no new layout primitive was introduced.

## Dogfood log

### 2026-07-30T12:59:25Z — pass (1/1) — source: tasks.md — commit: fa0414195b7f0cc7917c8956b88c9351ad11d6f3
- `npx vitest run test/unit/savedAgentProposalCommit.test.ts test/unit/agentProfileLifecycle.test.ts` — pass
