# 344 — validation-queue-governance — notes

_Created 2026-07-03._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- 2026-07-03: Draft uses `Validation` as the product/entity name and keeps `dogfood` as a possible open `type` value, not a top-level feature name.
- 2026-07-03: Draft keeps project-specific validation type labels open, following Task `kind`/`artifact_refs` decisions from spec 325.
- 2026-07-03: Fable review (`val344Fable`) agreed with `Validation`, standalone entity, open `type`, and separate `next_validation`, but rejected the first draft as not ready until the spec added existing-debt discovery, made standalone a decision rather than an open question, split lifecycle `status` from round `outcome`, removed redundant `owner`, cut `blocksRelease`, and added a default Mission Control pending signal.
- 2026-07-03: Implementation ships a compact Mission Control validation strip instead of a full separate tab. Reason: v1 needs default visibility and closure more than a second board. Validations stay visually separate from task columns and close through their own `ValidationStore`.
- 2026-07-03: Ad-hoc Claude Opus review (`val344-opus-review`) returned `NEEDS_FIX` with no blocker. Addressed the top findings by adding short discovery caching, making create-with-assignee produce a triaged validation instead of a stranded pending one, rejecting closeRound on already-closed validations, and adding tests for those invariants.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- 2026-07-03: `close_validation` and the Mission Control inline close form are the v1 closure surface; no separate `validation-detail` webview was added. This keeps the workflow small while still enforcing evidence/note-required closure.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- 2026-07-03: Discovery is read-only and returns candidates. This avoids noisy auto-created validations, but means a later import action is still needed if we want one-click conversion from candidate to validation.
- 2026-07-03: Discovery now has a short in-memory TTL cache. Tradeoff: Mission Control may show candidates up to a few seconds stale, but it avoids repeated filesystem scans during refresh storms.

## Verification log

- 2026-07-03: Passed after Opus fixes: `npm test -- test/unit/bridge.test.ts test/unit/auth.test.ts test/unit/boardSnapshot.test.ts test/unit/missionControlPanel.test.ts test/unit/validationStore.test.ts test/unit/nextValidation.test.ts test/unit/validationDiscovery.test.ts && npm run typecheck && npm run build`.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- Post-v1: add a richer import flow for discovered candidates if the compact strip proves insufficient.
- Post-v1: run installed-VSIX dogfood with a real human validation and screenshot the Mission Control strip/closure flow.
