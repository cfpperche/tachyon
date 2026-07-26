# 468 — runtime-native-memory-parity — tasks

_Generated from `plan.md` on 2026-07-26. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Inventory installed runtime mechanisms and Tachyon projections.
- [x] Define the fail-closed adapter capability shape.
- [x] Publish trust-boundary report and update parity matrix.
- [x] Create bounded follow-up tasks for measured gaps.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Report statements have named local/upstream evidence.
- [x] Typecheck and verify:full:quiet pass on the integrated tree.

**Headless check:** `npm run typecheck`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** research-only change; no runtime behavior or operator
surface is introduced.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** not required.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** no UI is changed.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <468>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

<!-- **Cookbook:** yes -->
**Cookbook-Opt-Out:** architecture report is the operator-facing artifact; no
new command or API is introduced.
