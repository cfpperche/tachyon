# 431 — Agent profile identity lifecycle — tasks

_Generated from `plan.md` on 2026-07-22._

## Design

- [x] Declare Affected Product Invariants before code.
- [x] Obtain independent review of commit ordering, lock set and cleanup allowlist.
- [x] Split distinct commit points into explicit follow-up Tasks.

## Implementation

- [ ] `t-152041` ships stopped-agent canonical rename and recovery.
- [ ] `t-c3605c` ships idempotent live-session convergence.
- [ ] `t-980e6e` ships retirement, custody-qualified cleanup and safe name reuse.
- [ ] Integration audit preserves the existing legacy rename/forget path.

## Verification

- [ ] Focused tests cover stale/collision/concurrency, every durable phase, retry and degraded state.
- [ ] Live/stopped rename and live forget refusal are covered headlessly.
- [ ] External bindings survive forget and completed name reuse gets a fresh `agentId`.
- [ ] Migration, lifecycle, Evolution and Workspace compatibility suites pass.
- [ ] Full configured verification and typecheck pass.

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run typecheck`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood-Opt-Out:** coordinating SDD only; each implementation follow-up owns representative headless dogfood.

## Visual QA

**Visual QA Opt-Out:** no visual surface changes in the identity kernel.

## Cookbook

**Cookbook-Opt-Out:** internal lifecycle service; operator UX ships in `t-149877`.
