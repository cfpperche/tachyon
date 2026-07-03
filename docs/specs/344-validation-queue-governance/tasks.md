# 344 — validation-queue-governance — tasks

_Generated from `plan.md` on 2026-07-03. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Lock final product naming and standalone entity boundary in the spec.
- [x] Define Validation type model with open `type` label and closed lifecycle/mechanical fields.
- [x] Define ValidationRound semantics: lifecycle status vs round outcome, failed rerun behavior, evidence/reason requirement.
- [x] Implement durable `ValidationStore` under `.tachyon/validations/` with atomic writes and CAS.
- [x] Implement discovery/import candidates for existing pending dogfood/manual-validation debt in pins/tasks/specs when present.
- [x] Add Bridge tools for create/list/get/update/claim/attach-evidence.
- [x] Add Mission Control Validations surface or filter.
- [x] Add default Mission Control pending-validation signal/badge.
- [x] Add validation detail/closure UI requiring evidence or reason.
- [x] Wire refresh fan-out so validation changes update open Mission Control/detail/sidebar surfaces.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Unit tests cover store create/update/CAS/corrupt-file behavior.
- [x] Unit tests cover open `type` labels and open `source_refs`.
- [x] Unit tests cover discovery candidates without auto-creating noisy validations.
- [x] Unit tests cover human-only validations not being selected for agents.
- [x] Unit tests cover failed validation rerun preserving prior round evidence.
- [x] Bridge tests cover validation bounds and evidence-required closure.
- [x] UI/model tests cover Mission Control visibility and pending counts.

**Headless check:** `npm test -- test/unit/validationStore.test.ts test/unit/nextValidation.test.ts test/unit/bridge.test.ts && npm run typecheck && npm run build`
**Verify:** `npm test -- test/unit/validationStore.test.ts test/unit/nextValidation.test.ts test/unit/bridge.test.ts && npm run typecheck && npm run build`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** Human dogfood should run against the installed VSIX; this implementation turn completed the mechanical path with unit/Bridge/UI-model tests and build.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Seed a project with one human validation, one agent validation, and one project-specific custom type; confirm Mission Control makes pending validation work visible, lets a human close with evidence/reason, and keeps Task status separate.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** The Mission Control validation strip is compact and covered by panel/model tests in this turn; live VS Code screenshot dogfood should happen after installing the generated VSIX for the next release pass.
