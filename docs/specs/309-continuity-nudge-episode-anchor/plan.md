# 309 — continuity-nudge-episode-anchor — plan

_Drafted from `spec.md` on 2026-07-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

Persist the activity seq associated with the last continuity pane nudge in `.tachyon/continuity/<agent>.state.json`.
Automatic continuity nags will keep the existing 15-minute cooldown, but add a stronger same-episode guard: if the
current activity seq is less than or equal to the stored `lastNudgeSeq`, Tachyon does not send another automatic nudge.

The guard belongs in `Workspace`, next to the existing side effects, because it needs both persisted continuity state and
the current activity seq. `ContinuityState` only persists the additional field and remains simple storage.

## Key decisions

- **Anchor by activity seq, not just wall clock** — chosen because repeated idle spam is the failure mode; rejected
  increasing the cooldown because it only delays the same bug.
- **Keep declared-agent nudges enabled** — chosen because first continuity prompts still protect long-running sessions;
  rejected globally disabling cold-start reminders because it regresses compaction/restart safety.
- **Apply the same guard to malformed-brief warnings** — chosen because they use the same nudge channel and can also
  repeat without new information; rejected limiting the fix to cold-start reminders because it leaves a near-identical
  nag loop.
- **Do not use the handoff anchor store** — chosen because continuity nudge state already persists per agent; rejected an
  in-memory-only anchor because it would reset after reload and could spam again.

## Files touched

- `src/continuity/ContinuityState.ts` — add `lastNudgeSeq` persistence.
- `src/workspace/Workspace.ts` — suppress automatic continuity nudges for an already nudged activity seq.
- `test/unit/continuityWiring.test.ts` — prove cold-start/malformed reminders are one-shot per seq and re-enable on new activity.
- `test/unit/continuityClassifier.test.ts` — prove `markNudged` stores the seq.
- `docs/specs/309-continuity-nudge-episode-anchor/*` — SDD contract, notes, verification, and closure.

## Risks & unknowns

- If the nudge itself is written to activity, anchoring on the post-nudge seq could suppress too aggressively. The code
  records the seq observed before the nudge, so only genuinely later activity re-enables the reminder.
- Manual UI-origin continuity reinjection must remain available even when the same seq was already nudged.
- Existing state files without `lastNudgeSeq` must remain valid.

## Sources consulted

- `src/workspace/Workspace.ts` — `maybeRemindCheckpoint`, `injectContinuity`, and handoff nudge anchoring pattern.
- `src/continuity/ContinuityState.ts` — persisted per-agent continuity state.
- `test/unit/continuityWiring.test.ts` — headless Workspace/tmux wiring tests.
- `test/unit/continuityClassifier.test.ts` — continuity state persistence tests.
