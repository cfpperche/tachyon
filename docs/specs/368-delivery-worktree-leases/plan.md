# 368 — delivery-worktree-leases — plan

_Drafted from `spec.md` on 2026-07-10. The approach, not the steps (those go in `tasks.md`)._

## Approach

Build this as a compatibility-preserving evolution of the existing gated-delegation path, in four phases.
The design introduces one canonical aggregate before changing spawn behavior; then moves existing reuse and
verification onto that aggregate; then adds lifecycle recovery and declared-identity binding; only after real
dogfood does it change the default orchestration path.

### Phase 1 — canonical Delivery aggregate and compatibility adapters

Add `src/delivery/` with a versioned, per-record `DeliveryStore`. A Delivery owns:

```ts
interface Delivery {
  schemaVersion: 1;
  id: string;                 // d-…; stable API identity
  version: number;            // CAS
  workspaceId: string;
  createdBy: DeliveryActor;   // durable provenance; never name-equality authority
  contract: {
    taskId?: string;
    baseSha: string;
    behaviorTest: string;
    owns: string[];
    taskRef: string;
    stubPath?: string;
  };                          // immutable after creation
  lease: DeliveryLease;
  segments: DelegationSegment[]; // append-only history
  gitDeliveryId?: string;     // projection reference
  legacy?: { delegationId?: string; sourcePath?: string; importedAt?: string };
  createdAt: string;
  updatedAt: string;
}
```

The store lives in a workspace-local SQLite database (`.tachyon/deliveries-v2.sqlite3`) and uses short
`BEGIN IMMEDIATE` transactions with full durability. SQLite, not application lockfiles, owns physical
cross-process exclusion and crash rollback; no PID, fence, claim, tombstone, or stale-lock reclaimer is persisted
by the application. A busy/locked database returns a structured retryable refusal. The backend is enabled only
after the extension runtime and workspace filesystem prove the supported local locking/durability domain;
unsupported or remote/unknown domains report capability unavailable with no lockfile fallback. Spawn, Git, tests,
and waits remain outside the transaction. Contract fields cannot be updated by the public mutation API; segment
history and events are append-only with unique IDs, and mutation retries use a durable operation receipt so a
post-commit response loss cannot duplicate work. The durable lease, rather than a store mutex, records long-lived
Delivery occupancy.

New gated spawns create a Delivery and segment zero. `GitDelivery` gains a `deliveryId` reference and remains
the Git projection (branch/worktree/current HEAD/review/integration/prune), not authority for lease or scope.
During transition, `verify_task` resolves new Deliveries through an adapter that exposes the immutable contract
and segment boundaries; legacy `DelegationRecord` remains readable. Do not dual-write a second mutable
DelegationRecord for a new Delivery.

Legacy migration is explicit and previewable (`delivery_import_legacy` preview/apply), never a startup-wide
mutation. Matching an optional GitDelivery requires exact branch ref plus canonical worktree realpath. Zero or
multiple matches, conflicting SHAs, incompatible scopes, or non-linear fixer boundaries fail closed. Existing
unimported delegations keep working through the old path. Legacy agent-name verification sugar uses the same
exactly-one-non-archived rule as `reuseWorktree`; latest-by-mtime resolution is forbidden.

### Phase 2 — exclusive lease service and generalized segments

Add a `DeliveryLeaseService` that owns acquisition, sequential transfer, verification occupancy, release,
liveness reconciliation, and quarantine. It operates under the Delivery record lock and the canonical
worktree-path mutex, and always rechecks live tmux/process and live Git state inside the critical section.

Every Delivery-bound execution is launched through a `ProcessFencePort` with a durable execution nonce. The
platform adapter must provide `freeze`, `terminate`, and `proveEmpty` over the execution's whole containment
group, including descendants that reparent or detach, plus an independent audit for processes whose canonical
cwd/root/open worktree binding targets the Delivery. Handoff and crash reconciliation share this exact predicate.
Only `proven_empty` permits successor reservation; `survivors` or `unknown` quarantines. Pane-root PID death is
never sufficient. A platform without a sound adapter reports capability unavailable and cannot enable sequential
handoff; it does not degrade to optimistic process-group guessing or a same-Delivery fallback worktree.

The supported-host spike returned **PARTIAL**: a PID-namespace containment core can retain and terminate detached
descendants, but the required independent global worktree-binding audit cannot prove absence because some
same-UID `/proc` entries are unreadable. The first production slice therefore implements the domain/store and an
explicit unavailable fence capability only. Sequential handoff remains disabled until a complete adapter can
return `proven_empty`; fake adapters are limited to unit tests.

Lease states:

```text
free ──reserve──> pending ──spawn confirms──> held ──clean terminal release──> free
                                      │
held ──handoff request──> draining ──stop + prove gone + revalidate──> pending
                   │
                   ├──atomic successor grant──> held (new segment)
                   ├──system verification─────> verifying ──restore HEAD──> held/free
                   └──dirty/unknown death─────> quarantined

quarantined ──salvage──> held (recovery segment)
quarantined ──abandon with proof/authority──> free|abandoned
```

The normal implement → review → fix transfer does not first publish `free` and never boots two runtimes against
one worktree. A short first mutation validates the handoff request and marks the predecessor `draining` while
retaining its lease. Tachyon then freezes/terminates that execution through `ProcessFencePort` outside the record
lock. Only after the entire containment group and worktree-bound process audit return `proven_empty` does a
second short critical section recheck clean status, expected HEAD, ancestor-linear history, and scope; any
uncertainty, survivor, or drift remains held/quarantined and prevents successor spawn. A valid transfer closes
the predecessor segment and writes a nonce-bound `pending` successor reservation.
Runtime spawn then happens outside durable locks. A short final mutation confirms that exact reservation as
`held`. Spawn failure/timeout consumes the reservation into a retryable failed-handoff/quarantine state; it never
implicitly revives the stopped predecessor. Restarting the predecessor is itself a new nonce-bound segment.
Contenders read `draining`/`pending` and immediately receive structured retryable `WORKTREE_OCCUPIED`, never an
opaque lock timeout. The flow never creates another worktree.

Extend `spawn_agent` with a Delivery join form (exact public spelling finalized during implementation) carrying
`delivery_id`, role, `owns_subset`, and `expected_head`. Preserve `reuse_worktree` as compatibility sugar that
resolves/imports its DelegationRecord and enters the same service. The primitive returns structured refusal;
`wait_for_lease` is a separate bounded watcher that holds no acquisition lock and returns on a meaningful state
change or timeout.

`verify_task` acquires a system verification lease before it mutates checkout state and refuses whenever the
canonical current holder is live — it never checks only segment zero's `record.agent`. Verification intent
durably records delivered HEAD plus its temporary checkout so reload reconciliation can restore a clean matching
interruption. It restores the delivered HEAD before releasing and persists its SHA-bound verdict against the
Delivery. Segment scope calculation generalizes today's boundary walk, but every adjacent boundary must be
ancestor-linear; non-linear history blocks verification/import instead of misattributing a tree diff. Each write
segment is evaluated against its own normalized `ownsSubset`; reviewer segments require HEAD/index/clean-tree
equality and do not create a commit range.

### Phase 3 — quarantine, review, and persistent-identity bound executions

Reconciliation distinguishes:

- live holder → held;
- gone holder + clean recorded HEAD → interrupted segment, retryable successor acquisition;
- gone/unknown holder + dirty tree, live child PID, ambiguous cwd, or HEAD drift → quarantined.

Expose quarantine in delivery/GitDelivery list and hygiene. `salvage` appends a recovery segment from the
observed committed HEAD and records dirty-tree evidence; it never calls that dirty state verified. `abandon`
requires an explicit expected HEAD and loss inventory. Discarding uncommitted data or unique commits is
human-authorized; non-destructive salvage may be performed by the original coordinator or a configured recovery
principal. Every decision is durable and attributed to the Bridge-resolved caller.

The holder liveness token persists pane-root PID plus process-start identity and boot/host generation. Reload
never frees a Delivery on tmux disappearance alone: unknown PID/process state is unavailable/quarantined. A
clean disappearance is retryable only when the recorded holder is provably gone and Git matches the recorded
HEAD. This deliberately strengthens the current `AgentManager` fallback that warns and frees when no PID was
captured.

Review uses an exclusive `reviewer` segment. Runtime-level read-only permissions are applied where an adapter
supports them, but the sound gate is the release postcondition: branch HEAD unchanged, index unchanged, tracked
tree clean, and verdict pinned to the acquired SHA. A violation records FINDINGS/invalid review; it cannot
produce ACCEPT.

For a declared/persistent identity, create a uniquely named ephemeral **bound execution** from its declared
AgentDef instead of moving or restarting its live home session. The lease records both `executionAgent` (the
Bridge-authenticated runtime identity) and `principal` (the declared identity selected by the coordinator).
The execution receives no inherited Bridge authority from `principal`; attribution is provenance, not
impersonation. Prune, abandon, salvage, waiver, and non-self-review policy use Bridge-resolved caller kind plus
configured coordinator/recovery principals — never `executionAgent`, `principal`, or `GitDelivery.agent` name
equality. This keeps cwd, private runtime home, resume binding, and continuity of the live persistent session
unchanged. A later identity-preserving runtime-rebinding design may replace the ephemeral mechanism, but is not
a prerequisite.

### Phase 4 — opt-in dogfood, default orchestration, and cleanup

Real sequential-lifecycle dogfood is capability-gated. On the current host, dogfood may prove structured
capability refusal and quarantine behavior, but cannot count as evidence for enabling handoff.

Add a workspace setting/profile switch for Delivery leases, initially opt-in. Dogfood a real gated sequence in
one Delivery/worktree: implementer commit → system verify → read-only reviewer FINDINGS → fixer commit → verify
→ reviewer ACCEPT → integration/hygiene. Exercise a second Delivery concurrently to prove parallelism remains.
Also kill a dirty occupant and prove quarantine plus authorized recovery.

Only after those checks pass should new gated implementation flows default to Delivery leases. Occupied same-
Delivery acquisition always refuses; a new worktree is created only by explicit creation of another Delivery.
Legacy records and `reuse_worktree` remain compatible for a deprecation window. Every linked GitDelivery
mutation runs under the canonical Delivery lock; transitions are idempotent so reconciliation can replay a
canonical transition after a crash between files. Lease state is never copied into GitDelivery. GitDelivery
prune/integration read canonical state under that lock and refuse pending, held, verifying, unknown, or
quarantined Deliveries. Delivery-less legacy projections use their own compatibility lock.

## Key decisions

- **Delivery is the isolation and authority aggregate** — chosen because contract, lease, role, and identity are
  not Git facts; rejected agent-owned worktrees because roles in one change fork unnecessarily, and rejected
  GitDelivery ownership because it would make a Git projection a second policy authority.
- **One worktree per Delivery; parallelism only across Deliveries** — chosen to preserve attribution and prevent
  semantic forks; rejected a parent-wide shared worktree because independent tasks would collide.
- **Structured refusal first, bounded wait on top** — chosen because a blocking acquire/implicit queue can
  deadlock and obscure ownership; rejected unbounded FIFO leasing.
- **Fenced stop precedes successor reservation** — chosen because durable `draining` retains authority while the
  predecessor is stopped and final Git state is revalidated; only then is a nonce-bound successor reservation
  allowed. Spawn runs outside locks. Rejected live-predecessor reservation because it permits two runtimes on one
  worktree, rejected release-then-acquire as racy, and rejected holding a durable lock across model boot.
- **Immutable contract plus append-only segments** — chosen to preserve fail-before/pass-after and prevent the
  last occupant from laundering scope or verifier changes; rejected mutable delegation inheritance.
- **DeliveryStore is cross-process locked, stale-owner-aware, and CAS-versioned** — chosen because multiple
  extension hosts/processes can mutate workspace state; rejected the process-local Promise mutex as sole
  authority and rejected PinStore's timeout-only lock as crash-unrecoverable.
- **Review is exclusive and postcondition-enforced** — chosen because `verify_task` changes checkouts and review
  tools can mutate caches/index even when logically read-only; rejected concurrent read leases in v1.
- **Bound execution separates principal from execution identity** — chosen to keep persistent sessions stable
  without permission laundering; rejected changing a live agent's cwd and rejected issuing a child the
  persistent agent's Bridge identity.
- **Explicit preview/apply legacy import** — chosen for deterministic rollback and visible conflicts; rejected
  eager startup migration and silent guessing.
- **Opt-in before default** — chosen because spawn semantics and cleanup safety are load-bearing; rejected a
  flag-day switch.

## Files touched

- `src/delivery/types.ts` — canonical Delivery, contract, lease, segment, event, and migration types.
- `src/delivery/store.ts` — atomic/CAS persistence, immutable-contract and append-only-segment enforcement.
- `src/delivery/leaseService.ts` — acquire, successor handoff, verification occupancy, reconcile, quarantine,
  salvage, abandon, and bounded state observation.
- `src/delivery/legacyImport.ts` — deterministic preview/apply import from DelegationRecord + GitDelivery.
- `src/agents/processFence.ts` — process-containment proof contract and supported-host adapter.
- `src/bridge/delegationRecord.ts` — legacy adapter/deprecation boundary; no longer the new-flow authority.
- `src/bridge/verifyTask.ts` — Delivery resolution, system verification lease, generalized segment scope.
- `src/bridge/tools.ts` — Delivery read/import/recovery/wait tools and Delivery-aware spawn/verify schemas.
- `src/agents/AgentManager.ts` — route Delivery joins through the existing forced-worktree spawn path and expose
  safe path locking/occupancy seams.
- `src/agents/reuseWorktree.ts` — compatibility resolution into a Delivery instead of fixer-only semantics.
- `src/workspace/Workspace.ts` — construct stores/services, create Delivery on gated spawn, wire bound execution,
  liveness, GitDelivery projection, and Bridge dependencies.
- `src/git-delivery/types.ts`, `store.ts`, `hygiene.ts`, `prune.ts` — `deliveryId` projection link and lease-aware
  fail-closed operations.
- `src/config/loadConfig.ts`, `src/config/tachyon.schema.json` — rollout and recovery-principal settings.
- `src/resume/SessionLedger.ts` — persist Delivery/segment binding for reload reconstruction.
- `test/unit/delivery*.test.ts` — aggregate, persistence, lease, migration, recovery, and bound-execution tests.
- `test/unit/verifyTask.test.ts`, `agentManager.test.ts`, `bridge.test.ts`, `gitDelivery.test.ts` — compatibility
  and integration coverage at existing seams.
- `test/integration/deliveryLease.e2e.test.ts` — real temp-git sequential handoff and parallel-Delivery exercise.
- `scripts/dogfood/delivery-lease.mjs` — representative headless lifecycle dogfood against built Tachyon modules.

## Risks & unknowns

- Holding filesystem and worktree locks in inconsistent order could deadlock. Define one global order:
  Delivery record lock → canonical worktree mutex → live Git/liveness checks; never acquire them in reverse.
- No durable lock may cover runtime spawn, model startup, test execution, or bounded waiting. Pending reservation
  state makes long operations visible and compensatable without obscuring `WORKTREE_OCCUPIED`.
- Spawn is an external side effect between reservation and confirmation. Failure compensation must be tested at
  every boundary so a phantom occupant is never persisted and a stopped predecessor is never marked live.
- The current `verify_task(agent)` API resolves the latest record by display name. Delivery identity must become
  primary without breaking legacy callers or accepting ambiguous name sugar.
- Reviewer read-only cannot rely solely on model instructions. Runtime restrictions are advisory; Git
  postconditions and SHA-pinned verdicts are the gate.
- Cross-process locking must handle stale lock owners without deleting an active lock. Persist process-start and
  boot identity; automatically reclaim only a provably dead owner, otherwise fail closed behind an authenticated
  recovery operation.
- Importing old DelegationRecord and GitDelivery records may expose historical drift. Conflicts must become
  diagnostics, not auto-repair.
- Segment grant/release boundaries must stay ancestor-linear. Rebase/force-reset is a quarantining verification
  blocker, not a supported rewrite of provenance.
- OS process containment is the hardest portability boundary. Empirically prove that the supported adapter detects
  a detached/reparented writer before enabling sequential handoff; unsupported hosts remain fail-closed.
- Bound executions must never inherit a declared agent's token or mutate its private runtime home. Verify actual
  env/config-home paths in tests for each supported runtime adapter.
- This spec crosses several load-bearing systems. Land phases sequentially, keep compatibility tests green, and
  run the full suite after every phase integration rather than accepting only focused child results.

## Visual impact

No new user interface is required for the first delivery. Bridge/list/hygiene output gains Delivery and lease
state, but this is structured text. **Visual QA Opt-Out:** the spec's first release is headless orchestration and
persistence; any later sidebar/Mission Control representation should be a separate visual task with real-host QA.

## Sources consulted

- `docs/specs/362-delegation-verification-gate/{spec,plan,notes}.md` — isolated gated refs, immutable verifier,
  fail-before/pass-after, and SHA-bound acceptance.
- `docs/specs/365-orchestrator-delivery-hygiene/{spec,plan,tasks}.md` — GitDelivery projection, live Git prune,
  actor policy, phases, and deferred review/integration work.
- `.tachyon/reviews/t-0b5723-fable.md` — Codex/Fable design dueto and replica.
- `src/bridge/delegationRecord.ts` — immutable original contract and `fixerAttempts` provenance.
- `src/bridge/verifyTask.ts` — current segmented scope boundaries and checkout-mutating verifier.
- `src/agents/{AgentManager,reuseWorktree}.ts` — forced-worktree spawn, realpath occupancy, in-process mutex,
  expected-HEAD and subset guards.
- `src/workspace/Workspace.ts` — gated worktree/stub creation and delegation persistence seam.
- `src/git-delivery/{types,store,prune,hygiene}.ts` — current Git projection, CAS, atomic write, and cleanup rules.
- `src/tasks/TaskStore.ts`, `src/pins/PinStore.ts` — workspace persistence and cross-process mutation patterns.
- `docs/specs/357-codex-session-identity/spec.md`, `src/resume/SessionLedger.ts` — stable runtime homes and reload
  identity constraints.
