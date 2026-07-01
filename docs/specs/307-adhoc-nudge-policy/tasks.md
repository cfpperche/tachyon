# 307 — adhoc-nudge-policy — tasks

_Generated from `plan.md` on 2026-06-30. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add a single runtime-neutral helper for automatic persistence nudge eligibility.
- [x] Gate automatic checkpoint/continuity reminder flow for plain ad-hoc agents.
- [x] Gate automatic project-handoff reminder flow for plain ad-hoc agents.
- [x] Preserve UI-origin manual continuity reinjection for ad-hoc agents.
- [x] Suppress generic/programmatic `injectContinuity(..., "manual")` for ad-hoc agents unless it carries UI origin.
- [x] Keep existing declared-agent behavior unchanged.
- [x] Record the Claude plan review in `notes.md` and fold any accepted changes back into `spec.md`/`plan.md` before implementation.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Unit test: plain ad-hoc Codex child receives no automatic continuity cold-start/stale reminder.
- [x] Unit test: plain ad-hoc Claude child receives no automatic continuity cold-start/stale reminder.
- [x] Unit test: plain ad-hoc AI child receives no automatic project-handoff reminder.
- [x] Unit test: declared Codex/Claude agents still receive automatic continuity/handoff reminders under existing threshold conditions.
- [x] Unit test: UI-origin manual continuity reinjection remains allowed for a plain ad-hoc AI child.
- [x] Unit test: generic/programmatic manual continuity reinjection is suppressed for a plain ad-hoc AI child.
- [x] Static check: the policy helper does not branch on runtime names.

**Headless check:** `npm test -- --run test/unit/continuityWiring.test.ts test/unit/projectHandoff.test.ts`
**Verify:** `npm test -- --run test/unit/continuityWiring.test.ts test/unit/projectHandoff.test.ts`
**Verify:** `npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npm test -- --run test/unit/continuityWiring.test.ts test/unit/projectHandoff.test.ts`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** spawn a temporary ad-hoc Claude or Codex reviewer, let it idle after activity, and verify Tachyon does not type a continuity or project-handoff nudge unless the human explicitly uses the manual reinject action.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->
