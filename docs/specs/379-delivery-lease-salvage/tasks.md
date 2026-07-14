# 379 — delivery-lease-salvage — tasks

_Generated from `plan.md` on 2026-07-14. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [ ] Delivery model: `salvaged` restricted state + fence-domain fields on the holder +
      audit event vocabulary (types.ts, store.ts migration; existing rows classify without
      history rewrite)
- [ ] Kill path: `kill_agent` → atomic `held → draining` (kill-attempt id, holder snapshot)
      BEFORE termination; AgentManager records termination outcome + descendant handling;
      kill never releases authority
- [ ] Draining observer: fence-death evidence + worktree-quiescence recheck (bounded,
      stable HEAD/index/status) → recoverable; anything unprovable stays `draining`
- [ ] Salvage transition: CAS on {state, lease version, holder tuple, fence domain} +
      atomic consumption of a bound single-use human-approval capability → `salvaged`
      (forensics preserved); `free` only via authorized verify/prune/recovery disposition
- [ ] Approval capability: nonce, expiry, bound digest {lease version, segment, holder
      tuple, fence-domain digest, probe digest, expected HEAD, status digest, disposition,
      caller}; replay/mismatch rejected; human-legible binding in the approval card
- [ ] Linux fence production wiring as EVIDENCE (capability-checked fence domain;
      inconsistency ⇒ ambiguous, never dead); UnavailableProcessFence fallback intact
- [ ] Bridge surface: `delivery_salvage` tool + structured `next` hints on
      verify_task/git_delivery_prune/delivery_join dead-holder refusals
- [ ] Tests: state machine + CAS/TOCTOU races + approval binding/replay + fence-domain
      ambiguity matrix + kill→draining + 378-wedge-shaped fixture salvage + no-weakening
      regressions (occupied deliveries still refuse everything)

## Verification

- [ ] All spec.md acceptance scenarios (as re-scoped by plan.md) have green tests
- [ ] Probe blockers re-checked one-by-one against the implementation (SECURITY review)
- [ ] verify_task gate green on the delegated branch

**Verify:** `npx vitest run test/unit/leaseSalvage*.test.ts test/unit/deliveryStore.test.ts`
**Verify:** `npm run typecheck`

## Dogfood

**Dogfood:** `npx vitest run test/unit/leaseSalvage*.test.ts`

**Human dogfood:** salvage the REAL wedged delivery d-spawn-79f528dd… (approval card →
salvaged → prune disposition) and confirm verify_task/prune stop refusing; then verify the
ownrot delivery post-kill drains and salvages cleanly.

## Visual QA

- [ ] Evidence: screenshot of the salvage approval card (binding digest human-legible)
- [ ] Verdict:
