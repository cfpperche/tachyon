# 388 — engine-rebind-transient-readiness — notes

_Created 2026-07-16._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-16: independent read-only reviews agreed on a dedicated uncached typed probe, an internal
  5-second/100-ms retry budget, and no new configuration or fake Codex dogfood.
- 2026-07-16: the separate generation-55 `can't find session` failure remains explicitly out of scope;
  this task ends at safe readiness admission and preserves the existing resume failure policy.

## Deviations

- None yet.

## Tradeoffs

- A fixed bounded wait can delay the default serial queue by up to five seconds for a structurally valid
  but permanently missing transcript.  This is accepted to keep the change small; permanent
  Delivery/snapshot/record denials bypass the wait.

## Open questions

- None.

## Dogfood log

### 2026-07-16T14:28:33Z — pass (1/1) — source: tasks.md — commit: 6fd1d71371a2a863973b003dc4cd3fde20ee0a45
- `node scripts/dogfood/persistent-engine.mjs` — pass

### 2026-07-16T14:40:33Z — pass (1/1) — source: tasks.md — commit: 5e71469305d9bd8285f48c7805a0cb08a935cb5d
- `node scripts/dogfood/persistent-engine.mjs` — pass

### 2026-07-16T14:43:54Z — pass (1/1) — source: tasks.md — commit: 3422ec91c8b9958d36a093e89a1bc861badc77a3
- `node scripts/dogfood/persistent-engine.mjs` — pass

## Verification log

### 2026-07-16T14:40:00Z — pass (1/1) — source: tasks.md
- `npx vitest run test/unit/bridgeClientRebind.test.ts test/unit/agentManager.test.ts test/unit/engineProcessBoundary.test.ts test/unit/engineSupervisor.test.ts && npm run typecheck` — pass

### 2026-07-16T14:42:41Z — pass (1/1) — source: tasks.md
- `npx vitest run test/unit/bridgeClientRebind.test.ts test/unit/agentManager.test.ts test/unit/engineProcessBoundary.test.ts test/unit/engineSupervisor.test.ts && npm run typecheck` — pass

## Closure evidence

- Implementation commit: `5e71469305d9bd8285f48c7805a0cb08a935cb5d`.
- Combined with the then-current `main` and reverified at merge head
  `3422ec91c8b9958d36a093e89a1bc861badc77a3`.
- Independent adversarial review: no findings after the final synchronous lifecycle-authority guard;
  378 focused tests, `tsc --noEmit`, and `git diff --check` passed in the review checkout.
- Final repository gate: `npm run verify:full:quiet` passed with 410 files and 4,687 tests passing;
  3 pre-existing skips remained explicit.
- Declared SDD verify and persistent-engine dogfood passed against both the implementation commit and
  the combined merge head.
