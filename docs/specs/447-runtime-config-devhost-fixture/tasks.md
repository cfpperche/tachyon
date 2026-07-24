# 447 — runtime-config-devhost-fixture — tasks

_Generated from `plan.md` on 2026-07-24. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [ ] Add controlled Global-home materialization to the Dev Host pointer and extension inventory.
- [ ] Create the complete fixture sources and manual walkthrough.
- [ ] Add regression tests for production-vs-Dev-Host source selection and source preservation.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [ ] Global and Workspace fixture sources are distinct and contain all intended evidence.
- [ ] Production source selection remains the real runtime home.

**Verify:** `npx vitest run test/unit/codexRuntimeConfigInventory.test.ts test/unit/workspace.test.ts`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** the controlled source is inspected through the manual F5 Dev Host path; the beta headless harness is not used for this visual/native-file surface.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** F5 `Tachyon: Dev Host`; inspect both scopes, edit one scalar in each, verify comments/unknown keys remain, then disable `fixture_remove` and confirm `fixture_keep` remains.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [ ] Evidence: installed Dev Host screenshots of both fixture scopes.
- [ ] Verdict:

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <447>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook-Opt-Out:** fixture setup is an internal development workflow covered by the Dev Host runbook and fixture README.
