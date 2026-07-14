# 379 — delivery-lease-salvage

_Created 2026-07-14._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

A canonical Delivery whose lease holder dies without a clean cleanup probe is wedged
**forever**: the lease stays `held` by a dead pid, and because production wires the
fail-closed `UnavailableProcessFence`, no code path can ever prove the holder dead —
`verify_task` refuses `WORKTREE_OCCUPIED`, `git_delivery_prune --abandon` refuses
(holder/tail principal mismatch), `delivery_join` refuses, and reload reconciliation is
read-only (classifies, never transitions). Reproduced twice in the spec-378 trail
(t-832fa2 landed **without a canonical verification record** because of it); the wedged
delivery `d-spawn-79f528dd80013dcc31e8182f53b09c00` is still on disk as a live fixture.

"Done" = a **governed salvage path** exists: (a) `kill_agent` releases the lease
synchronously as part of the kill (wedges stop being created for the common case), and
(b) a wedged lease can be explicitly salvaged — with mechanism-level death proof
(pid + processStart + bootId) when obtainable, or an explicit human-approved abandon when
not — leaving an auditable record of who authorized what. Breaking a lease is authority
to take a worktree: the path must be narrow, attributable, and fail-closed on ambiguity.

## Acceptance criteria

- [ ] **Scenario: kill releases the lease synchronously**
  - **Given** a gated agent holding its Delivery lease
  - **When** `kill_agent` completes (Bridge tool or sidebar ■)
  - **Then** the Delivery's lease is released (or transitioned to a terminal/salvageable
    state) **before** the kill call returns — an immediately following `verify_task`
    does not refuse `WORKTREE_OCCUPIED`
- [ ] **Scenario: mechanism-proof salvage of a dead holder**
  - **Given** a Delivery lease `held` by a process whose (pid, processStart, bootId)
    provably no longer exists on this boot
  - **When** the coordinator (a non-holder, Bridge-resolved caller) invokes the salvage
    transition
  - **Then** the lease transitions off `held` with evidence level `mechanism-only`
    recorded, the salvage is appended to the delivery's history with the caller identity,
    and `verify_task`/`delivery_join` become possible again
- [ ] **Scenario: unprovable death requires the human**
  - **Given** a Delivery lease `held` where death cannot be mechanically proven
    (fence unavailable, bootId mismatch impossible to evaluate, foreign boot)
  - **When** an agent requests salvage
  - **Then** the transition is refused with a structured code and the ONLY path forward
    is an explicit human approval (sidebar/approval flow), never an agent-only override
- [ ] **Scenario: a live holder can never be salvaged**
  - **Given** a lease whose holder process is alive (or liveness is ambiguous)
  - **When** salvage is invoked by anyone but the holder
  - **Then** it is refused — ambiguity fails closed, with the probe result recorded
- [ ] **Scenario: the spec-378 wedge is recoverable (live fixture)**
  - **Given** the real wedged delivery `d-spawn-79f528dd...` (holder pid 3196144, dead)
  - **When** the shipped salvage path runs against it
  - **Then** the lease releases and `git_delivery_prune`/`verify_task` stop refusing —
    this is the dogfood
- [ ] Salvage authority: holder ≠ caller enforced structurally; caller identity is the
  Bridge-resolved actor (never a parameter); every salvage/refusal appends an auditable
  record (who, when, evidence level, probe result)
- [ ] The Linux process fence (pid + processStart + bootId) is promoted from test-only to
  production wiring behind a capability check, with `UnavailableProcessFence` remaining
  the fallback on platforms where /proc semantics don't hold
- [ ] No weakening of existing refusals: verify_task/prune/join behavior for genuinely
  occupied deliveries is unchanged (regression-tested)

## Non-goals

- Automatic background salvage (a reaper that breaks leases on a timer) — v1 is
  explicit-invocation only (kill-path release + on-demand salvage); auto-reap needs its
  own risk discussion.
- Changing the lease state machine's happy path (acquire → held → draining → verifying)
  or the delegation-segment model.
- Windows-native process fencing (WSL /proc semantics are the target, same as the rest
  of the product).
- Salvaging QUARANTINED deliveries (quarantine already has salvage/abandon semantics in
  leaseService; this spec is about `held`-by-dead-holder).

## Open questions

- Should mechanism-proof salvage be invocable by any authenticated agent or only by the
  delivery's `grantedBy` lineage (creator/coordinator)? Leaning: grantedBy lineage +
  human always. To be settled in plan after the adversarial probe.
- Does the kill-path release belong in AgentManager.kill or in a Delivery-side observer
  of lifecycle events? (Ordering with the tmux kill and the cleanup probe matters —
  release must not race a still-running process.) Plan decision.
