# 430 — Agent profile lifecycle kernel — tasks

_Generated from `plan.md` on 2026-07-22._

## Design

- [x] Declare Affected Product Invariants before code.
- [x] Characterize every create/edit/spawn writer and resolve migration lock compatibility.
- [x] Obtain independent review of transaction phases, enablement and authority preservation.

## Implementation

- [x] Add profile-only enablement and trusted loader projection.
- [x] Implement redacted snapshot, opaque revision and structured intent validation.
- [x] Generalize the migration journal/coordinator and authority port; implement create/edit/set-enabled commit and recovery through it.
- [x] Wire Workspace authority/config ports and startup reconciliation.
- [x] Refuse disabled profile launch at the common AgentManager boundary.

## Verification

- [x] Focused tests cover create/edit/CAS, all phase failures, recovery/degraded state and idempotency.
- [x] Loader/manager tests cover disabled launch and legacy non-authorability.
- [x] Migration and Workspace compatibility suites pass; full gate covers plugin and PI-001 compatibility.
- [x] Full configured verification and typecheck pass.

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run typecheck`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npx vitest run test/unit/agentProfileLifecycle.test.ts test/unit/agentProfileConfigLoader.test.ts test/unit/harness.test.ts`

## Visual QA

**Visual QA Opt-Out:** no visual surface changes in the lifecycle kernel.

## Cookbook

**Cookbook-Opt-Out:** internal lifecycle service; operator UX ships in `t-149877`.
