# 503 — notify-agent-stranded-composer — tasks

_Generated from `plan.md` on 2026-08-13. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Record the live sequence and cause.
- [x] Add and run the red deadlock regression.
- [x] Add exact queue-head composer ownership detection.
- [x] Retry the staged line without retyping.
- [x] Prove unrelated human drafts remain held.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Focused delivery and composer tests pass.
- [x] `npm run verify:full:quiet` attests the final tree.

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run verify:full:quiet`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** The production door is exercised by the workspace test with the real queue/drain policy; spawning a live agent to wedge its composer would intentionally destroy its recoverability on the pre-fix binary.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** optional
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

_Do not create a prototype or evidence file just to satisfy this section. If a durable spec-specific artifact is useful, store it inside this spec directory (for example under `prototypes/` or `evidence/`) and reference its path in backticks after `Prototype:` or `Evidence:`. If it must live elsewhere, declare `**Artifact-Location-Opt-Out:** <reason>`._

**Visual QA Opt-Out:** No human-visible layout or styling changes.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <503>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

<!-- **Cookbook:** yes -->
**Cookbook-Opt-Out:** This repairs an internal delivery invariant and adds no operator surface.
