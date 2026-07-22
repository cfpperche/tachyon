# 427 — Agent identity and learned-state formation — tasks

_Generated from `plan.md` on 2026-07-22._

## Contract and decomposition

- [x] Inventory existing profile, Soul, instructions, Evolution, session and lifecycle boundaries.
- [x] Declare PI-001 affected with promise/oracle unchanged and plugins excluded.
- [x] Define distinct profile, lane, formation-generation and session-selector authority records.
- [x] Define no-downgrade modes, complete vector predicate and one migration cutover point.
- [x] Define immutable payload, recoverable publication/GC and operation-specific session transitions.
- [x] Remove runtime-managed memory into separate task `t-d4c42e`.
- [x] Obtain adversarial ratification after correcting blockers/majors.

## Foundation — `t-4d6385`

- [x] Characterize legacy/disabled bytes and plugin discovery/injection calls.
- [x] Add authority v2 + formation-generation transactional store and compatibility reader.
- [x] Add immutable object/snapshot store, prepare/commit recovery, leases and GC.
- [x] Add authenticated/idempotent fresh/fork selector operations and transition validators.
- [x] Prove complete-vector CAS/read barrier without enabling new lanes.

## Human lanes — `t-8f4420`

- [x] Bind Soul manifest/reference to `agentId` with compatible governed upgrade.
- [x] Add bounded no-follow `instructions.md` reader and coordinated transaction.
- [x] Migrate eligible legacy Soul/instructions without fallback or dual authority.
- [x] Deliver exact Soul/instruction and re-anchor bytes through immutable session payload.
- [x] Provide idempotent prepare/commit/recover/inspect/retire lifecycle primitives for `t-e50d4f`.

## Evolution lane — `t-59cbd6`

- [ ] Add `agentId`-bound complete Evolution active inventory/head.
- [ ] Exclude governance/recovery roots structurally and use bounded no-follow reads.
- [ ] Atomically promote lane head plus formation generation.
- [ ] Pin learning and all skill artifacts across fresh/resume/fork/re-anchor.
- [ ] Preserve existing human review and next-session activation semantics.

## Human-approved memory lane — `t-7217e1`

- [ ] Add selected-text manifest/active/candidate store with strict bounds and provenance.
- [ ] Add human-only promotion head plus formation-generation CAS.
- [ ] Add versioned renderer/framing and adversarial text tests.
- [ ] Pin exact selected-memory bytes across session operations.
- [ ] Prove raw transcripts, DBs, indexes and continuity are never discovered/imported.

## Integration — `t-3ef947`

- [ ] Integrate complete formation vector and stable lane lifecycle consumer contract.
- [ ] Prove migration/recovery/tamper/session/plugin matrices.
- [ ] Dogfood fresh launch, promotion, next session, resume, re-anchor and fork.
- [ ] Add architecture/operator documentation and closure evidence.
- [ ] Run PI-001, focused tests, typecheck and configured full verification.

**Headless check:** `npm test -- test/unit/agentFormation*.test.ts test/unit/evolutionPromptLayers.test.ts test/unit/soulProfileTransactions.test.ts`

**Verify:** `npm run test:invariants`

**Verify:** `npm run typecheck`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm test -- test/unit/agentFormationDogfood.test.ts`

## Visual QA

**Visual QA Opt-Out:** No new custom UI; complete lifecycle UI is owned by `t-e50d4f`.

## Cookbook

**Cookbook:** yes
