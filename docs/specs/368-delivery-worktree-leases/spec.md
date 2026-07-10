# 368 — delivery-worktree-leases

_Created 2026-07-10._

**Status:** in-progress

## Intent

Tachyon currently isolates a gated delegation by creating a worktree and task ref for its original agent. A
later fixer can reuse that worktree, but the underlying lifecycle is still agent-shaped: the original occupant
is special, reviewers commonly run elsewhere, and `DelegationRecord` and `GitDelivery` both describe parts of
the same branch/worktree without one canonical delivery identity. This preserves attribution but produces
redundant worktrees and branches, makes implement → review → fix handoffs social, and permits orchestration to
fork one logical change into multiple environments.

Make the **Delivery** the unit of isolation. One Delivery owns one worktree and one immutable verification
contract. Implementers, reviewers, and fixers — whether ad-hoc, declared, or persistent identities — occupy an
exclusive lease on that Delivery sequentially through append-only delegation segments. Independent work stays
parallel by using separate Deliveries. The lifecycle must preserve `verify_task` soundness, refuse same-Delivery
forks, recover safely from crashes, and migrate existing delegation and Git-delivery records without a flag-day
default change.

## Acceptance criteria

- [ ] **Scenario: a gated spawn creates one canonical Delivery**
  - **Given** a coordinator starts gated work with an immutable base SHA, behavior verifier, owned paths, branch,
    and worktree
  - **When** Tachyon persists the delegation
  - **Then** one stable Delivery identity owns that contract and references one Git projection for the branch and
    worktree
  - **And** the first implementer is represented as delegation segment zero rather than an out-of-band special case

- [ ] **Scenario: sequential roles share one worktree**
  - **Given** an implementer has released a clean Delivery at a committed HEAD
  - **When** a reviewer and later a fixer acquire it in sequence
  - **Then** all three segments reference the same Delivery, branch, and worktree
  - **And** each acquisition records the expected HEAD, role, identity, authority, and timestamp

- [ ] **Scenario: same-Delivery contention never forks**
  - **Given** a live occupant holds a Delivery lease
  - **When** another execution attempts to acquire that Delivery
  - **Then** Tachyon returns a structured retryable `WORKTREE_OCCUPIED` refusal
  - **And** creates neither a second worktree nor a second branch for that Delivery

- [ ] **Scenario: pending spawn is visible without holding the mutation lock**
  - **Given** the predecessor is durably stopped, its final clean HEAD is revalidated, and a successor acquisition
    has reserved the Delivery while its runtime is still starting
  - **When** another caller attempts acquisition or observes the lease
  - **Then** it receives durable `pending`/`WORKTREE_OCCUPIED` state immediately rather than a lock timeout
  - **And** a crashed or failed spawn is reconciled by its reservation token without fabricating a live holder

- [ ] **Scenario: independent Deliveries remain parallel**
  - **Given** two independent delegated changes
  - **When** the coordinator creates a Delivery for each
  - **Then** each Delivery receives its own branch, worktree, lease, and immutable contract
  - **And** both may have live occupants concurrently

- [ ] **Scenario: lease waiting is bounded and does not hold the lock**
  - **Given** an occupied Delivery
  - **When** a caller waits for its lease with a finite timeout
  - **Then** the wait returns on release, quarantine, disappearance, or timeout
  - **And** the waiting operation does not hold the acquisition mutex or silently enqueue an unbounded acquire

- [ ] **Scenario: handoff is atomic and head-pinned**
  - **Given** a holder is ready to release a clean committed Delivery to a named next role
  - **When** Tachyon performs the handoff
  - **Then** release and grant occur under one occupancy lock without an observable free interval
  - **And** a changed or unexpected branch HEAD refuses the handoff without transferring authority
  - **And** the successor runtime cannot start until the predecessor and its root process are proven stopped

- [ ] **Scenario: predecessor is fenced before successor spawn**
  - **Given** a live holder is selected for handoff
  - **When** Tachyon begins the transfer
  - **Then** it marks the lease `draining`, freezes/stops the predecessor's entire owned process containment group,
    proves every descendant/reparented member gone, audits surviving processes bound to the canonical worktree,
    and rechecks the clean expected HEAD before writing the successor reservation
  - **And** stop failure, unknown liveness, dirty state, or HEAD drift prevents successor spawn and remains held or
    quarantined
  - **And** successor failure never revives the stopped predecessor implicitly; any restart is a new segment
  - **And** pane-root death alone is insufficient proof; unsupported or incomplete process fencing quarantines the
    Delivery and prevents successor spawn

- [ ] **Scenario: authority is segment-scoped and cannot widen**
  - **Given** a Delivery with immutable `owns`
  - **When** a later writer acquires it with `ownsSubset`
  - **Then** acquisition succeeds only when the requested scope is a normalized subset of the original authority
  - **And** verification evaluates that writer's commit segment against the granted subset

- [ ] **Scenario: segment history is linear**
  - **Given** a Delivery has one or more completed write segments
  - **When** a successor is granted or the Delivery is verified/imported
  - **Then** each grant and release HEAD must be an ancestor of the next boundary and current task ref
  - **And** rebase, force-reset, or non-linear legacy provenance produces a structured fail-closed diagnostic

- [ ] **Scenario: review is exclusive and read-only**
  - **Given** a verified Delivery HEAD awaiting review
  - **When** a reviewer acquires the lease
  - **Then** the reviewer segment is pinned to that HEAD with role `reviewer` and empty write authority
  - **And** any commit or tracked-tree mutation by that segment prevents an ACCEPT transition

- [ ] **Scenario: verification and review cannot race**
  - **Given** `verify_task` must check out base and head revisions in the Delivery worktree
  - **When** verification is running
  - **Then** no reviewer or writer can acquire that Delivery concurrently
  - **And** review can begin only after verification restores and releases the pinned delivered HEAD
  - **And** exclusion is evaluated against the current lease holder, never segment zero's display name

- [ ] **Scenario: interrupted verification restores safely**
  - **Given** a system verification lease records the delivered HEAD and temporarily checks out another SHA
  - **When** the verifier process dies with a clean worktree still at its recorded temporary checkout
  - **Then** reconciliation restores the recorded delivered HEAD and marks verification interrupted/retryable
  - **And** quarantines instead when the tree is dirty or the observed state does not match the recorded intent

- [ ] **Scenario: persistent identities participate without cwd mutation**
  - **Given** a declared or persistent agent has a live home session
  - **When** it is selected for a Delivery role
  - **Then** Tachyon creates a Delivery-bound execution attributed to that persistent identity
  - **And** does not change the cwd, continuity home, or active runtime binding of the existing live session

- [ ] **Scenario: dirty crash enters quarantine**
  - **Given** a lease holder dies or disappears with uncommitted worktree changes
  - **When** Tachyon reconciles liveness and Git state
  - **Then** the Delivery becomes `quarantined` and cannot be acquired, verified, integrated, or pruned normally
  - **And** hygiene identifies the dead holder and dirty worktree

- [ ] **Scenario: quarantine resolution is explicit**
  - **Given** a quarantined Delivery
  - **When** an authorized coordinator chooses `salvage`
  - **Then** Tachyon records the decision and grants a bounded recovery segment without treating dirty state as a
    previously verified baseline
  - **When** an authorized coordinator instead chooses `abandon`
  - **Then** Tachyon proves which committed HEAD is retained and refuses any action that would silently destroy
    unique commits

- [ ] **Scenario: clean crash is reconciled safely**
  - **Given** a holder disappears with a clean worktree at the recorded HEAD
  - **When** Tachyon reconciles the lease
  - **Then** it records the interrupted segment and makes the Delivery retryable without fabricating successful
    completion or review

- [ ] **Scenario: immutable verification contract survives every occupant**
  - **Given** a Delivery has multiple implementer, reviewer, fixer, or recovery segments
  - **When** `verify_task` evaluates its current HEAD
  - **Then** fail-before/pass-after remains bound to the Delivery's original `baseSha` and behavior verifier
  - **And** no segment or migrated legacy record may rewrite the original `baseSha`, verifier, or `owns`

- [ ] **Scenario: reload reconstructs the lease fail-closed**
  - **Given** Tachyon reloads while a Delivery is held or quarantined
  - **When** durable records and live managed sessions are reconciled
  - **Then** the same holder/segment is recovered when provable
  - **And** ambiguous or unknown occupancy is treated as unavailable rather than free
  - **And** the durable liveness token distinguishes the original process from PID reuse across host generations
  - **And** handoff and crash reconciliation use the same process-containment absence predicate

- [ ] **Scenario: a process crash cannot permanently wedge the Delivery mutation store**
  - **Given** a process dies during a short SQLite Delivery mutation transaction
  - **When** another process opens the same supported local store
  - **Then** SQLite exposes either the complete pre-transaction state or the complete committed state
  - **And** no application lock, PID, fence, claim, or tombstone must be interpreted or reclaimed
  - **And** a workspace whose locking/durability domain cannot be validated remains capability-unavailable

- [ ] **Scenario: legacy verification name sugar is never ambiguous**
  - **Given** an agent display name maps to zero, one, or multiple non-archived legacy delegations
  - **When** legacy `verify_task(agent)` resolution runs
  - **Then** it proceeds only for exactly one candidate and otherwise returns a structured diagnostic naming all
    candidates rather than selecting by timestamp or mtime

- [ ] **Scenario: GitDelivery remains a projection, not a second authority**
  - **Given** a canonical Delivery and its Git projection
  - **When** branch, worktree, review, integration, hygiene, or prune state changes
  - **Then** Git-specific state is updated through the Delivery identity
  - **And** lease, immutable contract, and segment authority are read only from the canonical Delivery record
  - **And** projection mutations serialize under the canonical Delivery lock and are idempotently reconcilable
    after a crash between the canonical transition and projection write

- [ ] **Scenario: ephemeral execution identity cannot gain lifecycle authority**
  - **Given** a bound execution participates for a persistent principal
  - **When** it attempts prune, abandon, salvage, waiver, or non-self review policy decisions
  - **Then** authorization uses the Bridge-resolved caller plus configured coordinator/recovery principals
  - **And** neither ephemeral execution name nor attribution-only principal grants authority by equality

- [ ] **Scenario: legacy records migrate without losing verification provenance**
  - **Given** an existing `DelegationRecord` with zero or more `fixerAttempts` and an optional matching
    `GitDelivery`
  - **When** the migration/import path reads it
  - **Then** it deterministically produces one Delivery, segment zero, later fixer segments, and at most one Git
    projection while preserving task refs, SHAs, scopes, timestamps, and archival state
  - **And** ambiguous mismatches fail closed with actionable diagnostics rather than guessing

- [ ] **Scenario: rollout is opt-in before becoming the default**
  - **Given** an installation with the legacy per-delegation behavior
  - **When** Delivery leases first ship
  - **Then** existing delegations remain readable and the new lifecycle is exercised behind an explicit opt-in
  - **And** the default changes only after migration, verification, crash recovery, and real sequential handoff
    dogfood pass

- [ ] The canonical Delivery schema is versioned, persisted atomically, concurrency-guarded, and append-only for
  segment history.
- [ ] Mutating lease, handoff, quarantine, and recovery operations use Bridge-resolved caller identity and durable
  audit records.
- [ ] Git prune/integration refuses held, unknown, or quarantined Deliveries using live Git and liveness checks.
- [ ] The final implementation documents compatibility behavior and includes a representative headless dogfood of
  implement → verify → review → fix on one worktree.

## Non-goals

- Sharing one worktree between independent Deliveries.
- Allowing multiple simultaneous writers or concurrent verification/review on one Delivery.
- Moving a live persistent agent session into another cwd.
- Treating another worktree as an automatic fallback when a Delivery is occupied.
- Replacing Git worktrees, the `verify_task` behavior gate, or the GitDelivery integration/prune vocabulary.
- Shipping unbounded queues, automatic conflict resolution, automatic dirty-tree salvage, auto-merge, auto-push,
  or auto-prune.
- Making the first release a destructive migration or changing the default before opt-in dogfood.

## Open questions

No maintainer fork remains from the initial design. The plan resolves the three implementation choices as:

- v1 uses an ephemeral bound execution with separate runtime and principal identities, not live-session rebinding;
- legacy import is explicit preview/apply, never an eager startup migration;
- non-destructive salvage is limited to the original coordinator/configured recovery principals, while destructive
  abandon requires authenticated human approval and a concrete loss inventory.

Adversarial review may reopen any choice that it can tie to a concrete failure scenario.
