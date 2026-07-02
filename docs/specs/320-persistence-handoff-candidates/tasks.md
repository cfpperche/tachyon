# 320 — persistence-handoff-candidates — tasks

_Generated from `plan.md` on 2026-07-01. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Compare proposed candidate lane against existing Project Handoff pending notes.
- [x] Record owner decision to cancel the spec as overlapping/superseded.
- [x] Update umbrella 314 so the child-spec sequence has a final decision.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Spec status is `superseded` with a closure line.
- [x] Plan records the replacement path: improve pending-note triage/distillation if needed.
- [x] No implementation files are changed for a canceled feature.

**Headless check:** `grep -Fq '**Status:** superseded' docs/specs/320-persistence-handoff-candidates/spec.md`
**Verify:** `grep -Fq '**Status:** superseded' docs/specs/320-persistence-handoff-candidates/spec.md`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** Canceled/superseded spec; no runtime behavior shipped. The product behavior remains the existing Project Handoff pending-notes lane.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Open Project Handoff and confirm pending notes already provide the review buffer that this spec would have duplicated.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->
