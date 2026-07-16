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
