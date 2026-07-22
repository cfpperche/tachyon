# 425 — Agent profile resolver — tasks

_Generated from `plan.md` on 2026-07-22. Work top-to-bottom. If implementation changes the boundary,
update `spec.md` and `plan.md` before continuing._

## Contract

- [x] Declare `Affected Product Invariants: PI-001` with unchanged promise/oracle.
- [x] Separate resolver scope from `tachyon.yml` migration, runtime materialization and plugins.
- [x] Fix canonical-versus-legacy ownership, explicit inheritance and private-runtime conflict rules.
- [x] Define deterministic output, field provenance, structured errors and path/byte custody.

## Implementation

- [x] Add strict V1 wire/semantic schemas and stable exported diagnostic codes.
- [x] Add bounded descriptor-bound reads for `agent.yml` and declared local references.
- [x] Bind source selection to a host-custodied profile-head revision/digest.
- [x] Normalize canonical profiles with field-level provenance and no resolved/ambient secret values.
- [x] Normalize legacy `ManagedEntryDef` input without synthesizing an authoritative `agentId`.
- [x] Reject canonical+legacy double ownership and missing-source resolution.
- [x] Apply only explicitly requested workspace/environment inheritance.
- [x] Join ordered project-guidance provenance without rereading or copying project bytes.
- [x] Require exhaustive, versioned adapter attestation and reject unsuppressed runtime-native model/provider/environment/capability overrides.
- [x] Keep raw legacy command/environment values out of the normalized internal result.
- [x] Keep plugins and runtime projection writes outside the dependency graph.

## Verification

- [x] Focused resolver tests pass for valid canonical and legacy modes.
- [x] Schema/version/unknown-key/identity failures return stable errors and no partial value.
- [x] Symlink, traversal, special-file, digest-mismatch and changed-read cases fail closed.
- [x] Ancestor/pathname replacement cannot redirect profile-local references.
- [x] Model/provider/private-home and ambient environment conflicts cannot silently win.
- [x] Repeated reloads are deterministic; changed bytes produce a new digest or an explicit failure.
- [x] Diagnostics and serialized results contain no resolved secret values.
- [x] PI-001 focused invariant remains green with its fixed oracle unchanged.
- [x] Typecheck and full verification pass.

**Headless check:** `npm test -- test/unit/agentProfileResolver.test.ts`

**Verify:** `npm test -- test/unit/agentProfileResolver.test.ts`

**Verify:** `npm run test:invariants`

**Verify:** `npm run typecheck`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm test -- test/unit/agentProfileResolver.test.ts`

The focused suite creates real temporary workspace/profile trees and exercises the internal resolver;
installed runtime dogfood starts only after `t-4f82e0` wires profile-backed agents into launch/reload.

## Visual QA

**Visual QA Opt-Out:** this slice has no UI or rendered output.

## Cookbook

**Cookbook-Opt-Out:** internal resolver API; no operator command or Bridge tool is introduced.
