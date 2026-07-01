# 309 — continuity-nudge-episode-anchor — tasks

_Generated from `plan.md` on 2026-07-01. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add `lastNudgeSeq` to persisted continuity state and keep old state files compatible.
- [x] Add a Workspace same-episode suppression helper that combines cooldown and activity-seq anchoring.
- [x] Store the current activity seq when Tachyon sends automatic continuity checkpoint nudges.
- [x] Store the current activity seq when Tachyon sends malformed-brief warnings.
- [x] Preserve UI-origin manual reinjection behavior.

## Verification

- [x] Unit test: a cold-start reminder is not repeated after cooldown expiry unless activity seq advances.
- [x] Unit test: `lastNudgeSeq` persists with `lastNudgeAt`.
- [x] Unit test: malformed warnings use the same seq anchor.
- [x] Typecheck passes.

**Headless check:** `npm test -- --run test/unit/continuityWiring.test.ts test/unit/continuityClassifier.test.ts && npm run typecheck`
**Verify:** `npm test -- --run test/unit/continuityWiring.test.ts test/unit/continuityClassifier.test.ts && npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npm test -- --run test/unit/continuityWiring.test.ts -t "spec 309"`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** install the generated VSIX, leave a declared agent without continuity idle past the old cooldown, and confirm the pane does not receive repeated identical `set_continuity(...)` reminders until new activity is recorded.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->
