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

## Build decisions (2026-07-16)

The revised minimal cut reuses quarantine. Kill completion makes a held lease inert but does not claim descendant death. The held-entry boundary deliberately accepts canonical legacy holders that omitted `principal`; it still freezes the full lease and open tail for CAS and refuses any alive or ambiguous root before considering fence/approval evidence.

Recovery evidence is classified as `fence-proof` only when the fence capability domain is supported and identical on both sides of `proveEmpty`. Otherwise a caller-scoped, digest-bound approved receipt is required and the event says `approval-only`. Worktree-free abandonment never calls canonical-worktree or Git inspection seams.

The production fence remains `UnavailableProcessFence` until a complete host adapter (including its privileged audit helper and durable identity store) can be constructed safely. The recovery sites are now ready to consume a promoted adapter without treating a domain identifier as authority; shipping a partial Linux adapter here would weaken the fence contract.

## Correction round 1 (2026-07-16)

- **A:** Worktree-free abandonment now accepts the real `held` wedge shape directly. It validates the loose holder/tail boundary, observes the exact persisted process identity, refuses alive or ambiguous roots, consumes bound approval, and CASes `held → abandoned` with `approval-only` evidence. The flagship Case B begins held and deletes its worktree.
- **B:** Reconciliation, quarantine recovery, handoff, and review share the same before/after fence-domain guard. A changed or unsupported domain cannot turn an empty observation into trusted evidence.
- **C:** Live authenticated MCP coverage invokes `delivery_salvage` enter, salvage, and worktree-free abandon and proves all service actors come from the Bridge caller. The tool also exposes the existing worktree-present approved abandon path for prune disposition.
- **D:** Tests prove the holder execution agent, holder principal, and tail principal cannot authorize recovery even when configured as recovery principals.

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
