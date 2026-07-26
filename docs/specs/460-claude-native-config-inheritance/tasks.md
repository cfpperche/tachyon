# 460 — claude-native-config-inheritance — tasks

_Generated from `plan.md` on 2026-07-25. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Inventory current Claude materialization and record the profile-policy boundary.
- [x] Obtain adversarial review before selecting an authored settings boundary.
- [ ] Measure and define the closed Claude setting-key allowlist and rejection diagnostics.
- [ ] Declare exact supported native-policy tuples and implement the projected generation.
- [ ] Prove fresh/restart/resume/fork consistency plus absence of ambient/executable inheritance.
- [ ] Update parity evidence and, if applicable, Agent Studio authoring/visual proof.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [ ] Run focused policy, harness and lifecycle tests.
- [ ] Run configured typecheck and full verification.

**Headless check:** `npx vitest run test/unit/harness.test.ts test/unit/agentManager.test.ts test/unit/agentNativeConfigPolicy.test.ts`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** Real Claude configuration dogfood may use account authority; retain focused
lifecycle evidence until a bounded Dev Host scenario is prepared.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** If Studio authoring changes, save a canonical Claude profile and verify its
displayed policy matches the generated private projection without exposing raw runtime settings.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** No UI change is planned until a supported Claude authoring surface exists.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <460>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

<!-- **Cookbook:** yes -->
**Cookbook-Opt-Out:** Internal adapter policy; no new standalone operator workflow.
