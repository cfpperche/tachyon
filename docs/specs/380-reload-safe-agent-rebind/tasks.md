# 380 — reload-safe-agent-rebind — tasks

_Generated from `plan.md` on 2026-07-14. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add a coordinator preflight port that denies unsafe/unready resume before every teardown side effect.
- [x] Wire Workspace to the existing AgentManager generic-resume readiness authority.
- [x] Reapply the persisted single-home runtime environment during resume.
- [x] Require bounded replacement liveness before `resume_ok` and generation stamping.
- [x] Add deterministic regressions for Delivery no-stop, private Claude home, early exit, and healthy resume.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Focused AgentManager and Bridge-client-rebind suites pass.
- [x] `npm run typecheck` passes.
- [x] `npm run verify:full:quiet` passes once at the reviewable candidate.
- [x] Complete diff audit finds no Delivery authority expansion or unrelated file changes.

**Verify:** `npx vitest run test/unit/agentManager.test.ts test/unit/bridgeClientRebind.test.ts && npm run typecheck`
<!-- Canonical mechanical check for `/sdd verify`; preview by default, run only with --run. -->

## Dogfood

**Dogfood:** `npx vitest run test/unit/agentManager.test.ts test/unit/bridgeClientRebind.test.ts -t "reload-safe"`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** After an explicitly installed candidate, reload a window containing one ordinary
private-home reviewer and one live Delivery execution.  Confirm the reviewer resumes with context and
the Delivery process PID/session is unchanged.  The agent will not manipulate the VS Code window.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

**Visual QA Opt-Out:** No rendered surface changes; acceptance is lifecycle/audit behavior.
