# 441 — native-config-policy-foundation — tasks

_Generated from `plan.md` on 2026-07-23. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add policy vocabulary/schema and focused validation tests.
- [x] Add adapter-support admission and content-free provenance.
- [x] Round-trip policy through canonical Studio mutation/snapshot.
- [x] Render Studio provenance and unsupported empty state.
- [x] Update architecture/parity references if implementation changes the contract. No update required; implementation matches the ratified contract.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Existing profile/schema/projection fixtures remain green.
- [x] Unsupported policy fails with a stable diagnostic.
- [x] Studio domain and projection tests cover the new snapshot shape.
- [x] Typecheck and full verification pass.
- [x] Harden the adapter support seam with exact-tuple supported/unsupported decisions.
- [x] Prove supported-only, mixed-support, omitted and empty-policy behavior.
- [x] Document the nine measured architecture areas to eight families plus lifecycle mapping.

**Verify:** `npx vitest run test/unit/agentNativeConfigPolicy.test.ts test/unit/agentProfileConfigLoader.test.ts test/unit/agentProfileStudio.test.ts test/unit/agentStudioDomain.test.ts`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** adapter support is intentionally empty in this foundation; focused integration tests are the representative proof.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Open one canonical agent and inspect the read-only Native configuration section.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** deferred to the first adapter slice because this foundation intentionally supports no authored policy and the user excluded the beta desktop harness; the empty/read-only contract is covered headlessly.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <441>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook-Opt-Out:** the operator surface remains Agent Studio and is self-describing.
