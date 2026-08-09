# 309 — continuity-nudge-episode-anchor

_Created 2026-07-01._

**Status:** shipped
**Closure:** Shipped continuity nudge same-episode suppression with `lastNudgeSeq`; verified by focused unit tests, typecheck, and spec dogfood on 2026-07-01. Commit pending in this working turn.
**Verify:** `npm test -- --run test/unit/continuityWiring.test.ts test/unit/continuityClassifier.test.ts && npm run typecheck`
**Dogfood:** `npm test -- --run test/unit/continuityWiring.test.ts -t "spec 309"`

## Intent

Tachyon currently repeats the cold-start continuity reminder for a declared agent every cooldown window while the
workspace is left open. A user who leaves VS Code running can return to a terminal pane filled with the same
`set_continuity(...)` prompt, even though no new agent work happened after the first reminder.

Done means automatic continuity nags are anchored to the activity episode they warned about: after Tachyon sends a
checkpoint/malformed-brief nudge for activity seq N, it must stay silent for that same seq even after the time cooldown
expires. A later increase in the agent activity seq may make a new reminder eligible.

## Acceptance criteria

- [x] **Scenario: cold-start reminder does not repeat for idle same-state**
  - **Given** a declared agent with at least the reminder lag of activity and no continuity brief
  - **When** Tachyon sends the cold-start reminder and the cooldown later expires without additional activity
  - **Then** Tachyon does not send another cold-start reminder for the same activity seq
- [x] **Scenario: new work can be reminded again**
  - **Given** Tachyon already sent a cold-start reminder for activity seq N
  - **When** the agent appends more activity after N and the cooldown has elapsed
  - **Then** Tachyon may send a new reminder for the newer activity seq
- [x] **Scenario: malformed-brief warning does not repeat for idle same-state**
  - **Given** a declared agent with a malformed continuity brief
  - **When** Tachyon warns once and no new activity is recorded
  - **Then** Tachyon does not keep warning on every cooldown tick for that same seq
- [x] The persisted continuity state records the last activity seq associated with a pane nudge.

## Non-goals

- Changing the continuity reminder text.
- Disabling continuity nudges for declared agents entirely.
- Changing the ad-hoc nudge policy from spec 307.
- Changing project handoff nudge behavior, which already uses an activity anchor.

## Open questions

- None currently.
