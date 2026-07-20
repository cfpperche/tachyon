# 416 — adhoc-postmortem-retention — notes

_Created 2026-07-19._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-19 — Root cause: `AgentManager.list()` removes the clean-exited ad-hoc ledger row, while `cleanExited` and retained output are process-local. Engine reconstruction therefore has no row to rehydrate even though the durable pane transcript survives.
- 2026-07-19 — Preserve the authenticated Bridge delegator as the managed worktree `createdBy`; removal continues to use the existing creator-or-owner authorization and every dirty/occupancy guard.
- 2026-07-19 — A terminal marker is deliberately excluded from generic resume planning even if stale tmux discovery reports the old session as live; explicit restart/resume clears the marker when a new incarnation is created.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

None at implementation start.

## Dogfood log

### 2026-07-20T01:02:52Z — pass (1/1) — source: tasks.md — commit: 9b03e6d7c47e523e0d2b38a251be04f3dc9b9079
- `npx vitest run test/unit/agentManager.test.ts test/unit/managedWorktree.test.ts -t "postmortem across manager reload|coordinator retains authority" --maxWorkers=1` — pass

## Verification log

### 2026-07-20T01:02:54Z — pass (2/2) — source: tasks.md
- `npx vitest run test/unit/agentManager.test.ts test/unit/bridge.test.ts test/unit/resume.test.ts test/unit/managedWorktree.test.ts --maxWorkers=1` — pass
- `npm run typecheck` — pass
