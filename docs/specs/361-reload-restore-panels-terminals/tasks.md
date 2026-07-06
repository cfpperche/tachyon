# 361 — reload-restore-panels-terminals — tasks

_Generated from `plan.md` on 2026-07-06. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add trusted webview persistence/serializer helpers.
- [x] Wire serializers for Mission Control, Task Detail, Activity, Handoff, Server Inspector, Pin Studio, Task Studio, and Agent Studio Shell.
- [x] Persist and restore transient tmux-backed terminal tabs through `Terminals`.
- [x] Wire terminal restoration after workspace activation.
- [x] Run type/test verification.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Trusted panel serializers compile and are registered without plugin UI.
- [x] Terminal restore validates tmux liveness before reopening.

**Headless check:** `npm test -- --run`
**Verify:** `npm test -- --run`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** Headless VS Code reload dogfood is not available in this task; behavior is covered by serializer/manifest unit-level checks and compile/test verification.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** optional
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** reload restoration behavior is lifecycle/state plumbing; layout and styling are not changed.

Evidence: `npm run typecheck`; `npm test -- --run`
Verdict: Passed.
