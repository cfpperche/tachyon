# 455 — claude-canonical-parity — tasks

_Generated from `plan.md` on 2026-07-25. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add launch-boundary fresh/restart/resume canonical Claude lifecycle coverage.
- [x] Measure installed Claude permission-mode and graceful-stop behavior in a disposable TTY.
- [x] Retain the safe workspace-authored canonical permission projection: the measured CLI surface does
  not justify synthesizing a profile-wide `--permission-mode`, especially not bypass mode.
- [x] Prove Soul-enabled canonical Claude delivery and reconcile the matrix.
- [x] Run focused tests, typecheck, full verification, and integrate.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Canonical Claude lifecycle and runtime-profile tests pass.
- [x] `npm run typecheck` passes.
- [x] `npm run verify:full:quiet` passes on the integrated commit.

**Headless check:** `npx vitest run test/unit/agentManager.test.ts test/unit/harness.test.ts test/unit/runtimeProfile.test.ts`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** The decisive proof needs a disposable real Claude TTY because stop and startup
delivery are interactive-runtime behavior; unit lifecycle coverage remains the mechanical proof.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** In a disposable canonical Claude profile, inspect private home state after fresh,
restart, and resume; verify the startup Soul offer and stop behavior without approving any new prompt.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** No rendered UI change is planned.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <455>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook-Opt-Out:** Internal runtime parity work; no new operator surface.
