# 456 — grok-canonical-parity — tasks

_Generated from `plan.md` on 2026-07-25. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Verify and strengthen canonical Grok launch-boundary fresh/restart/resume coverage.
- [x] Measure installed Grok permission/config semantics and correct profile evidence.
- [x] Record the explicit no-injection boundary; an authored policy needs a typed source projection.
- [x] Reconcile the parity matrix and run focused tests, typecheck, full verification, and integrate.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Canonical Grok lifecycle and runtime-profile tests pass.
- [x] `npm run typecheck` and `npm run verify:full:quiet` pass on the integrated commit.

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

**Dogfood-Opt-Out:** The installed Grok CLI can prove parser/config behavior through help and bundled
documentation without a model request; interactive attention/composer work needs a distinct live
measurement task.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** optional: use a disposable canonical Grok profile, inspect `GROK_HOME` after
fresh/restart/resume, and confirm no auth is copied into it.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** No rendered UI change.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <456>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook-Opt-Out:** Internal runtime parity work; no new operator surface.
