# 436 — canonical-profile-forget — notes

_Created 2026-07-22._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- The two accidental `new.sh` allocations (`434-help`, `435-canonical-profile-forget`) were removed before authoring. The shared allocator intentionally never reuses reserved IDs, so this spec is 436.
- The task's preservation rule wins over the legacy footprint list: canonical forget quarantines the canonical home and does not delete runtime homes, worktrees, secrets, or ambiguous name-only state.

## Deviations

- Completed receipts also protect retained name-only state from legacy startup GC. Without that exclusion, a later reload could erase a runtime home after the transaction correctly preserved it.
- The generic migration reconciler now ignores the sibling `rename/` and `forget/` coordinator directories; otherwise a committed forget receipt was falsely reported as a corrupt legacy migration.

## Tradeoffs

- Runtime homes and ambiguous bindings remain name-scoped because runtime-managed memory architecture is a separate task. Receipts prevent deletion; this slice does not reinterpret or migrate their contents.

## Open questions

None.

## Verification log

### 2026-07-22T23:50:36Z — pass (2/2) — source: tasks.md
- `npm run verify:full:quiet` — pass
- `npm run typecheck` — pass

## Dogfood log

### 2026-07-22T23:52:33Z — pass (1/1) — source: tasks.md — commit: 885f8e9d893b4487afd405a47e7475dd6f2187f6
- `npx vitest run test/unit/agentProfileForget.test.ts test/unit/workspaceHeadless.test.ts` — pass
