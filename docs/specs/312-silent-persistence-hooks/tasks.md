# 312 — silent-persistence-hooks — tasks

_Generated from `plan.md` on 2026-07-01. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Confirm Claude/Codex hook output contracts for `SessionStart` and `Stop` with focused local tests or fixtures.
- [x] Define a persisted-agent-only eligibility predicate shared by hook injection and visible nudge suppression.
- [x] Materialize a Claude persistence hook settings layer additively with existing ownership hook.
- [x] Materialize a Codex persistence hook config additively with existing ownership hook.
- [x] Implement deterministic hook scripts for continuity rehydrate and handoff bookkeeping.
- [x] Disable visible continuity/handoff pane nudges when silent persistence hooks are active.
- [x] Add tests proving ad-hoc agents do not receive persistence hooks.
- [x] Add tests proving user/project hooks are not replaced.

## Verification

- [x] Unit tests cover Claude generated hook config shape.
- [x] Unit tests cover Codex generated hook config shape.
- [x] Unit tests cover persisted-only/ad-hoc-off policy.
- [x] Unit tests cover visible nudge suppression when hooks are active.
- [x] Typecheck passes.

**Headless check:** `npm test -- test/unit/sessionOwners.test.ts test/unit/harness.test.ts test/unit/continuityWiring.test.ts test/unit/config.test.ts && npm run typecheck`
**Verify:** `npm test -- test/unit/sessionOwners.test.ts test/unit/harness.test.ts test/unit/continuityWiring.test.ts test/unit/config.test.ts && npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npm test -- test/unit/continuityWiring.test.ts -t "spec 312"`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** install the VSIX, run a persisted Claude and Codex agent through resume/clear/stop cycles, and confirm no visible continuity/handoff reminders are typed into the pane while activity/continuity/handoff state still updates.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->
