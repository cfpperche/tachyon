# 400 — pi-session-continuity — tasks

_Generated from `plan.md` on 2026-07-18. Work top-to-bottom._

## Implementation

- [x] Add Pi's mint/exact-resume adapter and complete self-managed session flag detection.
- [x] Implement secure per-agent Pi session-directory materialization.
- [x] Implement bounded exact-id/cwd Pi JSONL resolution with symlink refusal.
- [x] Inject/persist Pi's private session directory across spawn/restart/resume without affecting self-managed commands.
- [x] Extend readiness, transcript lookup and resume admission to require the resolved Pi transcript.
- [x] Wire daemon resolver/materializer dependencies and preserve existing runtimes.
- [x] Add focused adapter, resolver, lifecycle, isolation and failure tests.
- [x] Add and run local-provider real-Pi two-process continuity dogfood.
- [x] Update Pi runtime documentation and SDD evidence; leave the stacked branch unmerged.

## Verification

- [x] Managed Pi spawn persists a minted id and private session home.
- [x] Exact-id resume preserves conversation and re-injects Bridge without primer paste.
- [x] Same-cwd agents remain isolated and hostile/missing transcripts fail closed.
- [x] Self-managed Pi session commands retain ownership and no false resume block.
- [x] Existing runtime tests remain green outside the two documented inherited baseline failures.

**Verify:** `npx vitest run test/unit/adapters.test.ts test/unit/resume.test.ts test/unit/agentManager.test.ts test/unit/piSession.test.ts`
**Verify:** `npm run test:invariants`

## Dogfood

**Dogfood:** `node scripts/dogfood/pi-session-continuity.mjs`

**Human dogfood:** In an isolated Dev Host fixture, talk to managed Pi, stop it, select Resume, and confirm Pi displays the prior conversation and `/tachyon-bridge-status` remains connected.

## Visual QA

**Visual QA Opt-Out:** Phase 2 reuses existing Resume UI; the changed contract is session identity and transcript continuity, proven through lifecycle dogfood.

## Cookbook

**Cookbook-Opt-Out:** managed Pi continuity is automatic and uses the existing Start/Stop/Resume operator flow.
