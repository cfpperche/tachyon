# 469 — runtime-config-dropdown

_Created 2026-07-26._

**Status:** shipped
**Closure:** Implemented under `t-e0734d`; focused regression, typecheck and full verification pass.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Verify:** `npx vitest run test/unit/runtimeConfigDropdown.test.ts`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`

## Intent

Control → Runtime Config currently renders one button per runtime in a segmented control. That grows
horizontally with every adapter and gives runtime identity no visual affordance. Replace only the
runtime selector with a compact dropdown that presents the selected runtime's product icon and name,
while preserving the existing document/scope selection and editor state.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: Select a runtime**
  - **Given** Runtime Config has two or more runtime inventories
  - **When** the user opens the runtime dropdown and chooses another runtime
  - **Then** the trigger shows that runtime's icon and name and the first document for that runtime becomes active
- [x] **Scenario: Keyboard operation**
  - **Given** focus is on the runtime dropdown
  - **When** the user operates it with the keyboard
  - **Then** the menu exposes the available runtimes through the existing accessible dropdown semantics
- [x] Each dropdown option shows the corresponding runtime icon and localized runtime name.
- [x] The scope/document selector remains unchanged.

## Non-goals

- Adding new Runtime Config adapters.
- Changing source-file, scope, save, or pending-session behavior.
- Redesigning the scope segmented control.

## Open questions

None.
