# 452 — agent-studio-canonical-trust-copy — tasks

_Generated from `plan.md` on 2026-07-25. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add and translate the canonical trust disclosure label.
- [x] Render it beside Working directory only for canonical forms.
- [x] Add regression coverage for localization and placement.
- [x] Run New/Edit visual QA at desktop and narrow widths.
- [x] Verify, close, integrate, and land the exact tested tree.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Focused Agent Studio tests pass.
- [x] `npm run typecheck` passes.
- [x] `npm run verify:full:quiet` passes on the integrated commit.

**Headless check:** `npx vitest run test/unit/agentStudioProfileActions.test.ts test/unit/agentStudioAdapter.test.ts`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** The meaningful proof is the browser-rendered New/Edit preview captured under Visual QA.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Inspect canonical New/Edit Agent in the Dev Host preview at desktop and narrow widths.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [x] Evidence: `.tachyon/vqa/visual-qa/agent-studio-trust-*.png`
- [x] Verdict: recorded in `notes.md` and attached to worktree evidence.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <452>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook-Opt-Out:** Copy-only UI clarification; no new operator surface.
