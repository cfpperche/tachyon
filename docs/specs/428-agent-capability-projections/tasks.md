# 428 — Agent capability projections — tasks

_Generated from `plan.md` on 2026-07-22._

## Implementation

- [x] Ratify the measured-adapter boundary through independent design review and update the spec.
- [x] Add strict capability selectors, payload schemas, and host-custodied grants.
- [x] Resolve local/shared payloads with no-follow custody, digest binding, hook classification, and collision checks.
- [x] Bind the resolved capability snapshot and provenance into the effective profile digest.
- [x] Attach profile-only launch metadata without widening legacy `tachyon.yml` syntax.
- [x] Materialize through existing private-home adapters and emit a manifest only after successful rebuild.

## Verification

- [x] Focused schema/resolver tests cover local/shared scope, grants, literal secrets, hook classes, collisions, symlinks, changed/mismatched bytes, and deterministic digest/provenance.
- [x] Harness tests cover supported adapter mappings, source/projection tamper, rematerialization, incomplete writes, and manifest contents.
- [x] Existing plugin and legacy harness tests remain green.
- [x] `npm run test:invariants` remains green; PI-001 is unchanged.
- [x] Full configured verification and typecheck pass.

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run typecheck`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npx vitest run test/unit/agentProfileConfigLoader.test.ts test/unit/harness.test.ts`

## Visual QA

**Visual QA Opt-Out:** no visual surface changes.

## Cookbook

**Cookbook-Opt-Out:** internal profile-to-runtime projection contract; no new operator command or Bridge tool.
