# 314 — persistence-hooks-v2 — tasks

_Generated from `plan.md` on 2026-07-01. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Scaffold and draft the umbrella spec.
- [x] Scaffold and draft child spec 315 for Stop hook dogfood.
- [x] Scaffold and draft child spec 316 for hook health diagnostics.
- [x] Scaffold and draft child spec 317 for hook failure logging.
- [x] Scaffold and draft child spec 318 for persistence settings UI.
- [x] Scaffold and draft child spec 319 for ledger retention.
- [x] Scaffold and draft child spec 320 for semantic handoff candidates.
- [x] Fold Claude review findings into the umbrella and affected child specs.
- [x] Ratify child-spec order with the owner before implementing the first child.
- [x] Record final owner decision that spec 320 is superseded by existing pending notes.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] All child spec directories exist.
- [x] Umbrella has no implementation claims marked shipped.
- [x] Each child spec has acceptance criteria and non-goals.
- [x] Umbrella plan explicitly records that execution order is not numeric order.

**Headless check:** `test -d docs/specs/315-persistence-stop-hook-dogfood && test -d docs/specs/316-persistence-hook-health-diagnostics && test -d docs/specs/317-persistence-hook-failure-log && test -d docs/specs/318-persistence-settings-ui && test -d docs/specs/319-persistence-ledger-retention && test -d docs/specs/320-persistence-handoff-candidates`
**Verify:** `test -d docs/specs/315-persistence-stop-hook-dogfood && test -d docs/specs/316-persistence-hook-health-diagnostics && test -d docs/specs/317-persistence-hook-failure-log && test -d docs/specs/318-persistence-settings-ui && test -d docs/specs/319-persistence-ledger-retention && test -d docs/specs/320-persistence-handoff-candidates`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** Umbrella planning spec only; child specs carry behavior-specific dogfood.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** owner confirms child-spec order before implementation starts.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->
