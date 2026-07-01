# 316 — persistence-hook-health-diagnostics — tasks

_Generated from `plan.md` on 2026-07-01. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Draft plan.md after failure-log and retention inputs are known.
- [x] Generate implementation tasks from the approved plan.
- [x] Add parser/helper coverage for persistence hook failure rows.
- [x] Attribute handoff-pointer failures to the agent when silent persistence failure logging is active.
- [x] Add `Workspace.persistenceHookHealth()` state classifier.
- [x] Thread persistence hook health through sidebar VM types/model.
- [x] Render compact sidebar hook-health badge for non-active states.
- [x] Add focused tests for active/skipped/failed states and VM pass-through.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Active health covered by Workspace wiring test.
- [x] Skipped health covered by custom Claude `--settings` wiring test.
- [x] Failed health covered by failure-ledger wiring test.
- [x] Unknown and stale-failure recovery paths covered by Workspace wiring test.
- [x] Sidebar VM pass-through covered by agent model test.
- [x] Typecheck passes.

**Verify:** `npm test -- test/unit/sessionOwners.test.ts test/unit/harness.test.ts test/unit/agentModel.test.ts test/unit/continuityWiring.test.ts && npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** This is a state classifier plus sidebar VM/UI plumbing. Headless tests exercise current-spawn injection state and failure-ledger rows; human visual dogfood is useful after installing the VSIX but is not required to prove the classifier.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** optional
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->
