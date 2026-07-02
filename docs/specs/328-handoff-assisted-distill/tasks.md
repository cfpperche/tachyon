# 328 — handoff-assisted-distill — tasks

_Generated from `plan.md` on 2026-07-02. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add a pure handoff-distill prompt builder with capped optional instruction text.
- [x] Extend the Handoff view model and host snapshot with running AI-agent targets and ad-hoc runtimes.
- [x] Add typed webview actions for starting a distill task.
- [x] Add the Distill UI in the Handoff panel.
- [x] Wire host handling for existing-agent send and ad-hoc spawn.
- [x] Keep Open/Refresh behavior unchanged.
- [x] Refine ad-hoc selection from runtime-only to profile plus read-only command preview.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Unit tests prove the prompt includes approval, CAS, and watermark instructions.
- [x] Unit tests/typecheck cover the new webview message/view-model shapes.
- [x] Unit tests prove ad-hoc profile ids resolve only through host-owned allowlisted commands.
- [x] Build/package the VSIX for human dogfood.

**Headless check:** `npm test -- test/unit/handoffDistill.test.ts test/unit/handoffViewModel.test.ts test/unit/webviewPreviewRoutes.test.ts && npm run typecheck`
**Verify:** `npm test -- test/unit/handoffDistill.test.ts test/unit/handoffViewModel.test.ts test/unit/webviewPreviewRoutes.test.ts`
**Verify:** `npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npx @vscode/vsce package`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Install `/home/goat/tachyon/tachyon-0.54.43.vsix`, reload VS Code, open Project Handoff, use Distill once with an existing agent or ad-hoc profile, and confirm the selected agent receives a draft-only distillation task.

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [x] Evidence: preview route `handoff:default` captured and inspected locally.
- [x] Evidence: preview route `handoff:default` captured and inspected locally after profile refinement.
- [x] Verdict: pass — compact header action plus inline form, no obvious overlap or hierarchy problem; ad-hoc command preview is visible and legible.
