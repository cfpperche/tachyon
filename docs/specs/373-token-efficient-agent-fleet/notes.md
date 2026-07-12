# 373 — token-efficient-agent-fleet — notes

_Created 2026-07-11._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-11 — Split from spec 372. Spec 372 changes the quiet runner/default only; this dependent spec owns fleet
  allocation, verification frequency, batched audit, and context lifecycle so output reduction can land without a
  concurrent `tachyon.yml` edit or a mixed cause/effect measurement.
- 2026-07-11 — Luna means `gpt-5.6-luna` at low effort for deterministic mechanical corrections. Terra medium remains
  the only general implementation lane. Neither worker receives unresolved architecture/design decisions.
- 2026-07-11 — Repository inspection resolved the rotation ambiguity: `AgentManager.restart` reinjects a fresh runtime
  session while reusing the worktree and redelivering instructions; `resume` replays the existing transcript. A tmux
  pane may retain scrollback, so dogfood must inspect model session identity rather than pane identity.

## Deviations

None.

## Tradeoffs

The policy spends a restart/bootstrap turn at selected task boundaries in exchange for bounded context and avoids
paying that cost while a task is still active. It deliberately does not claim that either choice resets provider quota.

## Open questions

None before implementation. Exact live preflight evidence is deliberately an implementation task because availability
can drift after this plan is committed. Mission Control task: `t-53622a`, dependent on SDD 372 task `t-434bcc`.
