# 379 — delivery-lease-salvage — notes

_Created 2026-07-14._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Field finding (2026-07-14, pre-plan)

`delivery_join` with `role: "recovery"` + fresh operation_id + expected_head SUCCESSFULLY took
over a lease `held` by a dead holder (delivery d-spawn-fcc8dab4, agent ownrot → ownrot2), after
the worktree was made clean (predecessor WIP checkpoint-committed by the coordinator — join
refuses DELIVERY_WORKTREE_DIRTY otherwise). So a takeover mechanism ALREADY EXISTS; the salvage
spec should generalize/expose it rather than invent a new transition:
- verify_task / git_delivery_prune refusals should POINT at the recovery path;
- kill_agent should still release synchronously (avoid needing recovery for the common case);
- salvage-without-successor (release the lease with nobody joining, e.g. for prune/verify of a
  finished branch) is the genuinely missing piece — the 378 wedge became unrecoverable the
  moment its branch merged+deleted (expected_head unresolvable ⇒ no recovery join possible).

## Happy-path verification finding (t-c5c204, 2026-07-14)

The healthy `d-spawn-39638e6a…` refusal was not caused by `UnavailableProcessFence`:
`DeliveryVerificationLeaseService` does not consult ProcessFence. Canonical gated spawn persisted
`principal=<agent>` on its initial segment but omitted the same attribution from the held holder,
so strict holder/tail identity rejected every such record before reaching the intentional live-tail
guard. The narrow correction writes both sides for new spawns and auditably repairs only the old,
attested canonical-spawn shape during verification. A genuinely live tail still blocks verification
because `verify_task` temporarily checks out other SHAs; stop it and retry. The dead-holder salvage
problem remains the separate scope of spec 379.
