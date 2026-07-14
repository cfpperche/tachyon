# 379 — delivery-lease-salvage — plan

_Drafted 2026-07-14 from spec.md + adversarial probe (codex, probe-dc698046 — 6 blockers, 3 majors;
full result in .tachyon/probes/probe-dc698046-597a-4b7b-8773-e4c5d010d975/result.json) + field
finding (recovery join already takes over a dead-holder lease; see notes.md)._

## Approach

Narrow, human-gated v1. The probe refuted three of the spec's leanings — autonomous
mechanism-proof salvage, release-to-free, and kill==release — so v1 becomes:

1. **Kill path**: `kill_agent` atomically transitions `held → draining` (kill-attempt id,
   holder snapshot, timestamp) BEFORE termination. A Delivery-side observer then needs BOTH
   fence-death evidence AND worktree quiescence (stable HEAD/index/status across a bounded
   recheck) to leave `draining` toward a recoverable state; unprovable ⇒ stays `draining`.
   Kill authority ≠ salvage authority: killing never implicitly revokes the lease.
2. **Salvage transition** (the missing exit): `draining|held-by-dead-holder → salvaged`, a
   RESTRICTED state (forensics preserved: former holder tuple, evidence, history) — never
   `free`. Only explicitly authorized verify/prune/recovery may act on a `salvaged`
   delivery; ordinary acquisition is refused. `free` only after one of those establishes a
   safe disposition.
3. **Authority = human, always (v1)**: every salvage consumes a SINGLE-USE approval
   capability minted by the existing human-approval flow, bound to {lease row version,
   segment id, former-holder tuple, fence-domain digest, probe digest, expected HEAD,
   worktree status digest, requested disposition, caller identity, expiry(nonce)} and
   consumed atomically in the same SQLite transaction as the CAS state transition — any
   mismatch (lease version moved, HEAD moved, holder changed) rejects and forces a fresh
   probe + approval. No agent-only mechanism salvage in v1, regardless of lineage.
4. **Fence promotion, demoted to evidence**: the Linux fence (pid+processStart+bootId)
   ships as EVIDENCE-GATHERING for the approval card and the observer, not as autonomous
   authority. Lease acquisition additionally records a fence-domain identifier (distro/env
   identity, pid-namespace identity, bootId, start-ticks semantics, fence impl version);
   probes are only meaningful within an identical domain — any inconsistency reads
   `ambiguous`, never `dead`.
5. **Refusal UX**: verify_task / git_delivery_prune / delivery_join refusals for
   dead-holder leases now POINT at the recovery/salvage path (structured `next` hint)
   instead of dead-ending.

## Key decisions

- **Human approval for ALL v1 salvage** — probe blocker: any authenticated-agent salvage
  (even grantedBy-lineage) lets a hostile agent manufacture takeover pressure; approval is
  a bound, single-use, atomically-consumed capability, not a pane string. Rejected:
  lineage-gated mechanism salvage (spec's original leaning).
- **`salvaged` restricted state, not `free`** — probe blocker: free destroys forensics and
  allows reacquisition before verify/prune inspect the wedge. Rejected: overloading
  `quarantined` (its salvage semantics stay a non-goal) and `abandoned` (already means
  something else to prune).
- **Kill → draining, observer completes** — probe blocker: pane death ≠ holder-execution
  death ≠ worktree quiescence (descendants, detached children, hooks). Rejected:
  synchronous release inside AgentManager.kill (the spec's original acceptance 1 as
  written).
- **CAS everywhere** — probe blocker (TOCTOU): every transition compare-and-swaps
  {state, lease version, full holder tuple, fence domain}; a changed row forces re-probe.
  The store's optimistic versioning already exists — extend it to holder-tuple CAS.
- **Audit schema per probe** — immutable event id, wall+mono time, lease version
  before/after, former-holder tuple, fence domain+impl version, raw observation fields +
  error class, probe executor, caller token subject, approval nonce/expiry, kill-attempt
  linkage, expected/actual HEAD, status digest, transition, txn result. No raw HMACs.
- **Dogfood limitation accepted**: the 378 wedge (branch merged+deleted) is recoverable to
  `salvaged`+prune-disposition only (no expected_head for a recovery join) — that IS the
  acceptance scenario for salvage-without-successor.

## Files touched

- `src/delivery/types.ts` — `salvaged` state; fence-domain on holder; audit event types
- `src/delivery/leaseService.ts` — draining-on-kill entry, salvage transition (CAS +
  approval consumption), observer hook
- `src/delivery/store.ts` — holder-tuple CAS, audit append, migration for new state
- `src/agents/AgentManager.ts` — kill path requests draining (never releases); descendant
  outcome recorded
- `src/agents/processFence.ts` + `linuxProcessFence.ts` — production wiring behind
  fence-domain capability; evidence report shape
- `src/bridge/tools.ts` — salvage tool (`delivery_salvage`) + refusal `next` hints on
  verify/prune/join; approval request integration
- `src/bridge/approvalRequest.ts` — bound single-use approval capability (nonce, digest
  fields, atomic consumption API)
- `src/workspace/Workspace.ts` — approval resolution wiring (host-side)
- `test/unit/*` — state machine, CAS/TOCTOU, approval binding/replay, fence-domain
  ambiguity matrix, kill→draining, refusal hints; fixture replay of the 378 wedge shape

## Risks & unknowns

- `src/delivery/leaseService.ts` is 1.5k lines of subtle state machine — the highest-risk
  edit surface in the product; SECURITY review tier mandatory (full adversarial pass on
  the diff), plus the probe's blockers re-checked one by one against the implementation.
- Migration: existing wedged rows (2 on disk) must classify into the new model without
  rewriting history rows.
- Approval UX: binding digest must be human-legible in the approval card (the human signs
  WHAT, not just WHO).
- Overlap: `src/workspace/Workspace.ts` + `AgentManager.ts` are shared surfaces with the
  hermes trail — keep hunks minimal; sequence after hermes lands if it lands first.

## Visual impact

Approval card for salvage (existing approval surface, new content) + sidebar/board hints
on refusals. Screenshot of the approval card in the evidence channel before land.

## Sources consulted

src/delivery/{types,store,leaseService,verificationLease,reloadReconciliation,projectionService}.ts ·
src/agents/{AgentManager,processFence,linuxProcessFence}.ts · src/bridge/{tools,approvalRequest}.ts ·
probe-dc698046 (adversarial, codex) · field finding notes.md (recovery join takeover) ·
wedged deliveries d-spawn-79f528dd… / d-spawn-61b2679c… (live fixtures)
