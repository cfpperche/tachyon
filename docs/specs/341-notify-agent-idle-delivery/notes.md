# 341 — notify-agent-idle-delivery — notes

_Created 2026-07-03._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Typecheck log

### 2026-07-03 — pass
- `npm run typecheck` — pass

## Verification log

### 2026-07-03T18:19:07Z — pass (1/1) — source: tasks.md
- `npm test -- test/unit/notifyAgent.test.ts test/unit/noticeQueue.test.ts test/unit/tmux.test.ts test/unit/bridge.test.ts test/unit/workspaceHeadless.test.ts` — pass

### 2026-07-03T18:20:53Z — pass (1/1) — source: tasks.md
- `npm test -- test/unit/notifyAgent.test.ts test/unit/noticeQueue.test.ts test/unit/tmux.test.ts test/unit/bridge.test.ts test/unit/workspaceHeadless.test.ts` — pass

## Human/live dogfood log

### 2026-07-03 — pass (installed 0.55.8, real Claude recipient)
- Spawned ad-hoc Claude target `dogfood341-target` from `codex-2`.
- Target opened a real busy window with `sleep 45` from 15:36:46 to 15:37:31.
- `notify_agent(to:"dogfood341-target", summary:"spec341 dogfood notice...")` was called while the target was mid-turn and returned `queued 'dogfood341-target' for idle delivery`.
- Reading the target pane during the busy window showed no `[tachyon]` envelope stuck in the composer.
- After the target went idle, the queued notice appeared as a fresh submitted turn:
  `[tachyon] codex-2 -> dogfood341-target: spec341 dogfood notice sent while target should be busy; please report when you saw this`.
- Target confirmed the notice arrived only after idle and did not interrupt the running shell command or active turn.
- Separate observation: after reporting, the target left its own text `append this result to the project handoff` in its composer; this was not the queued notice delivery under test.
