# 453 — agent-studio-static-sections — tasks

_Generated from `plan.md` on 2026-07-25. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Replace the three configuration disclosures with static semantic sections.
- [x] Add shared card styling and remove obsolete form-disclosure styling.
- [x] Add regression coverage for static rendering and preserved conditional harness behavior.
- [x] Run focused tests and Visual QA for New/Edit at desktop and narrow widths.
- [x] Run final gates, integrate, and land.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Focused Agent Studio layout tests pass.
- [x] `npm run typecheck` passes.
- [x] `npm run verify:full:quiet` passes on the integrated commit.

**Headless check:** `npx vitest run test/unit/studioWorktreeFooterLayout.test.ts test/unit/agentStudioProfileActions.test.ts`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** The meaningful end-to-end proof is the browser-rendered New/Edit preview captured
under Visual QA.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Inspect New/Edit Agent previews and confirm the three configuration sections are
always expanded without disclosure affordances.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [x] Evidence: `.tachyon/vqa/visual-qa/agent-studio-static-sections-*.png`
- [x] Verdict: recorded in `notes.md`.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <453>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook-Opt-Out:** Presentation-only form change; no new operator surface.
