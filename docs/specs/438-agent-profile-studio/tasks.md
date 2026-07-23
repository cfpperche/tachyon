# 438 — agent-profile-studio — tasks

_Generated from `plan.md` on 2026-07-22. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Review the current Agent Studio, lifecycle and bundle seams and obtain one architecture critique.
- [x] Create `t-fdb422` for canonical snapshot + CAS create/edit.
- [x] Create `t-293326` for enable/disable/rename/forget actions.
- [x] Create `t-ecd405` for portable clone/import/export actions.
- [x] Create `t-fa332a` for provenance UI, localization, accessibility and final proof.
- [x] Complete `t-fdb422`: canonical redacted snapshot and CAS create/edit.
- [x] Complete `t-293326`: revisioned enable/disable, rename and confirmed forget actions.
- [x] Complete `t-ecd405`: portable clone/import/export actions.
- [ ] Complete `t-fa332a`: final presentation and proof.
- [ ] Complete all four child Tasks without routing canonical writes through legacy YAML submit.

## Verification

- [ ] Child focused tests cover stale CAS, redaction, transaction routing, bundle round-trip and legacy compatibility.
- [ ] `npm run test:invariants` passes with PI-001 unchanged.
- [ ] Full verification and typecheck pass after the final child.

**Headless check:** `npx vitest run test/unit/agentStudioAdapter.test.ts test/unit/agentStudioDomain.test.ts test/unit/workspaceHeadless.test.ts`

**Verify:** `npm run typecheck`

**Verify:** `npm run verify:full:quiet`

<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npx vitest run test/unit/agentStudioAdapter.test.ts test/unit/agentStudioDomain.test.ts`

**Human dogfood:** Installed Dev Host create/edit/disable-enable/clone-export-import/rename/forget flow after all child Tasks land.

<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

## Visual QA

- [ ] Capture installed Agent Studio in dark, light and high-contrast themes.
- [ ] Record a verdict for provenance readability, conflicts, focus and destructive-action hierarchy.

## Cookbook

**Cookbook-Opt-Out:** existing Agent Studio is the operator surface; the delivery adds no CLI or Bridge tool.

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <438>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

<!-- **Cookbook:** yes -->
<!-- **Cookbook-Opt-Out:** pure internal refactor; no new operator surface -->
