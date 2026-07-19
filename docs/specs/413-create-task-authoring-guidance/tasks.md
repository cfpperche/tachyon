# 413 — create-task-authoring-guidance — tasks

_Generated from `plan.md` on 2026-07-19. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add canonical Task authoring limits and bounded, non-echoing domain messages.
- [x] Apply the shared limits at the TaskStore defensive boundary.
- [x] Preserve native Zod maxima while adding received/max guidance to every bounded `create_task` field.
- [x] Document umbrella/follow-up, task-note, and durable-artifact authoring choices in the tool contract.
- [x] Add MCP and TaskStore regression coverage for atomic rejection and field-specific errors.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Focused unit tests cover body/title/kind/ref/count boundaries, four-slice guidance, secret non-echo, and no Task creation.
- [x] `listTools` proves canonical `maxLength`/`maxItems` remain advertised.
- [x] Existing PI-001 behavior tests remain green.
- [x] Repository typecheck and full verification pass.

**Headless check:** `npx vitest run test/unit/bridge.test.ts test/unit/taskStore.test.ts`
**Verify:** `npx vitest run test/unit/bridge.test.ts test/unit/taskStore.test.ts`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npx vitest run test/unit/bridge.test.ts -t "create_task rejects oversized authoring input atomically with decomposition guidance"`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** optional
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** no visual surface changes; the affected contract is MCP text and JSON schema.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <413>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook-Opt-Out:** existing `create_task` surface is clarified in-place; no new operator workflow or command is introduced.
