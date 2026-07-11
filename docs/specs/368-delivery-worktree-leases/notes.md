# 368 — delivery-worktree-leases — notes

_Created 2026-07-10._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

### T0 review mechanism

- `probe-3b090dfe-3706-4fa4-aee1-6bab3034a9fb` — Claude Opus adversarial probe timed out after 120s with no
  result artifact; not accepted as review evidence.
- `probe-03e68304-050b-44d0-a533-e8f3f22126b6` — Codex GPT-5.6 adversarial probe failed in the adapter with
  `Reading additional input from stdin...`; not accepted as review evidence.
- Fallback: temporary ad-hoc `review368`, read-only except for
  `.tachyon/reviews/368-delivery-worktree-leases-adversarial.md`. Production implementation remains gated on
  its review and a post-fold ACCEPT round.

### T0 adversarial findings disposition

Review: `.tachyon/reviews/368-delivery-worktree-leases-adversarial.md` — verdict FINDINGS.

- **F1 HIGH — folded.** Persist PID + process-start + boot/host identity; reload treats unknown as unavailable/
  quarantined and never frees on tmux disappearance alone.
- **F2 HIGH — folded.** `verify_task` exclusion keys on the canonical current holder, not segment zero.
- **F3 HIGH — folded.** Legacy agent-name verification requires exactly one non-archived candidate; mtime selection
  is forbidden.
- **F4 HIGH — folded.** Delivery locks gain provably-dead reclamation and authenticated ambiguous-lock recovery;
  PinStore's timeout-only lock is explicitly insufficient.
- **F5 MEDIUM — folded.** Runtime spawn moves outside locks behind nonce-bound durable `pending` reservation, so
  contenders receive structured occupancy instead of lock timeout.
- **F6 MEDIUM — folded.** Lifecycle authority uses Bridge-resolved/configured principals only; execution/principal/
  GitDelivery display-name equality never grants destructive authority.
- **F7 MEDIUM — folded.** Linked GitDelivery mutations serialize through the Delivery lock and projection transitions
  are idempotently replayable; lease state is not copied into the projection.
- **F8 MEDIUM — folded.** Segment boundaries must be ancestor-linear; rebase/reset blocks verification and import.
- **F9 LOW — folded.** Verification persists restore intent so a clean interrupted temporary checkout can be restored
  automatically; inconsistent state still quarantines.

T0.1 must re-review the folded documents and return ACCEPT before T1 begins.

### T0.1 finding disposition

Review: `.tachyon/reviews/368-delivery-worktree-leases-adversarial-r2.md` — verdict FINDINGS.

- **R2-F1 HIGH — folded.** The prior reserve-then-spawn wording allowed a live predecessor to overlap successor
  boot. Handoff now persists `draining`, stops and proves the predecessor/root process gone, revalidates final Git
  state, and only then closes the prior segment and writes `pending`. Successor spawn stays outside locks. Failed
  spawn cannot implicitly revive the predecessor; a restart is a new segment.

T0.2 must confirm this fence closes the last concurrency gap before T1 begins.

### T0.2 finding disposition

Review: `.tachyon/reviews/368-delivery-worktree-leases-adversarial-r3.md` — verdict FINDINGS.

- **R3-F1 HIGH — folded.** Pane-root death was not a filesystem fence because detached/reparented descendants
  could survive. Every Delivery execution must now launch through `ProcessFencePort`; handoff and crash
  reconciliation share a `proven_empty|survivors|unknown` predicate over the complete containment group plus a
  canonical worktree-bound process audit. Survivors/unknown quarantine and block successor spawn. Unsupported
  hosts report capability unavailable rather than weakening the invariant. A detached-child empirical spike is
  required before production work.

T0.3 must confirm the process-fence contract closes R3-F1 before T1 begins.

### T0.3 closure

Review: `.tachyon/reviews/368-delivery-worktree-leases-adversarial-r4.md` — **ACCEPT**.

The reviewer confirmed the shared tri-state `ProcessFencePort` predicate, whole containment group, independent
canonical-worktree process audit, durable anti-PID-reuse identity, and unsupported-host fail-closed behavior close
R3-F1 without reintroducing a free gap. Architecture review is complete. Production work remains gated only on
the empirical detached-child spike declared as T0.2.

### T0.2 empirical result — PARTIAL

Study: `.tachyon/studies/368-process-fence-spike.md`.

- A PID-namespace init retained/reparented the detached writer and terminating the namespace containment removed
  its members, validating a promising containment core.
- Pane/root PID, process group, and session alone were disproven as fences.
- The independent same-UID global `/proc` audit encountered unreadable entries, so canonical cwd/root/open-FD
  absence cannot be proven on this host. `proveEmpty` must therefore return capability unavailable/`unknown`.
- Sequential same-worktree handoff stays disabled and quarantined; there is no fallback or optimistic downgrade.
- Spike resources were cleaned up. T1 may proceed because it defines only the canonical aggregate/store and does
  not enable handoff. A complete production fence adapter remains a prerequisite for T5-T7 and real dogfood.

## Deviations

### T5 current-host acquisition boundary

T5 implements and tests atomic `pending` reservation, durable idempotent acquire/confirm receipts, normalized
authority, HEAD/ancestry checks, and structured contention. The production `ProcessFencePort` remains explicitly
unavailable on this host, so none of those primitives enable real successor acquisition yet. The second HEAD read
narrows in-process drift, but cross-process Git/worktree exclusion remains deliberately unproven and capability-
gated until T7 supplies the complete containment plus independent worktree-binding absence proof. R1 findings are
closed by `43c02bd`/`b23547a`; adversarial R2 accepted the slice in `.tachyon/reviews/368-delivery-lease-t5-r2.md`.

### T6 no-fallback Delivery join boundary

T6 adds the `delivery_join` Bridge/AgentManager channel and reuses only a coordinator-prepared canonical worktree;
it is mutually exclusive with every path that creates or reuses a legacy worktree. Spawn confirmation failure
terminates the new runtime and invokes durable reservation compensation; incomplete teardown/compensation is
surfaced as an `AggregateError`, never swallowed. The current host supplies no certified preparation callback, so
the public path remains `DELIVERY_LEASE_UNAVAILABLE` before tmux until T7 wires the complete fence. R1 found the
initial silent-compensation gap; `81741bb` closed it and R2 accepted the delta.

### T7 implementation contract — fenced handoff and quarantine

T7 is a service/state-machine slice only. It does **not** certify this host, add a production fence adapter, or
enable `delivery_join` in Workspace. Production remains `DELIVERY_LEASE_UNAVAILABLE`; only unit tests may inject a
certified `ProcessFencePort`.

**Owned files:** `src/delivery/types.ts`, `src/delivery/leaseService.ts`, `src/agents/processFence.ts`, and
`test/unit/deliveryLeaseService.test.ts`. No Bridge, AgentManager, Workspace, GitDelivery, config, or ledger edits.

**Type/API decisions:**

- `DeliveryLeaseHolder` gains `executionNonce?: string`. `confirmHeld` consumes `reservationNonce` and persists the
  same value as `executionNonce`; a held predecessor without process identity plus execution nonce is ineligible
  for handoff.
- Add a handoff input carrying Delivery id, canonical worktree, expected final HEAD, successor role/name/principal,
  normalized `ownsSubset`, Bridge-resolved `grantedBy`, and one stable `operationId`.
- Add a worktree inspection port returning `{ headSha, clean }`; do not infer cleanliness from HEAD alone.
- Add structured fail-closed codes for fence/quarantine/invariant outcomes. Occupied/store-busy stays retryable;
  scope, path, head, ancestry, capability, and quarantine outcomes are non-retryable until state changes.
- Add `failPending(deliveryId, reservationNonce, reason, operationId)` for T6 spawn compensation. Exact nonce only;
  it moves the pending lease to `quarantined`, retains evidence, and is receipt-idempotent.

**Handoff algorithm (binding):**

1. Check `ProcessFencePort.capability()` before store or Git reads. Normalize/validate successor authority before
   touching the predecessor.
2. Under Delivery mutex then canonical worktree mutex: reload the Delivery; require `held`, exact canonical path,
   an open tail matching `holder.segmentId`, durable process identity and `executionNonce`, expected live clean
   HEAD, ancestor-linearity from the tail's granted HEAD, and successor authority within the immutable contract.
3. Short CAS transaction A changes only `held -> draining`, retaining the predecessor holder and open segment and
   appending a nonce/operation-bound `handoff_draining` event. Contenders must immediately see
   `WORKTREE_OCCUPIED`; no free interval exists.
4. Outside every Delivery/worktree/SQLite lock, attempt `freeze`, then `terminate`, then `proveEmpty` using the
   predecessor `executionNonce` and canonical worktree. A freeze/terminate exception is remembered even if later
   proof says empty. Runtime spawn, waiting, and tests never occur here.
5. Any freeze/terminate error, `survivors`, or `unknown` result performs an exact draining-state CAS to
   `quarantined`, retains the predecessor holder/open segment, records structured evidence, and throws a visible
   quarantine error. If quarantine persistence also fails, surface an `AggregateError`; never report a clean
   refusal while compensation is uncertain.
6. Only `proven_empty` with no prior fence-operation error may proceed. Re-enter Delivery mutex then worktree
   mutex; reload and require the exact same draining holder/execution nonce. Inspect the worktree twice around
   final checks; dirty state, HEAD drift, non-linear ancestry, state/holder change, or inspection uncertainty
   quarantines instead of reserving a successor.
7. Short CAS transaction B atomically closes the predecessor segment at the final HEAD, appends exactly one
   successor segment, writes a nonce-bound `pending` successor holder, and appends `handoff_reserved`. No runtime
   starts inside the transaction; T6 starts only after this method returns.
8. Lost responses are replay-safe. Derive stable receipt ids from `<operationId>:drain`, `:reserve`, and
   `:quarantine`; validate durable event intent before returning cached results. A retry after transaction B
   returns the original reservation nonce/result and never re-fences or appends another segment.

**Required tests (serial, fake fence only):**

1. capability unavailable performs no mutation and calls no fence method;
2. successful handoff calls freeze→terminate→proveEmpty outside locks, closes one predecessor, appends one
   successor, and returns one pending reservation on the same canonical worktree;
3. a detached/surviving predecessor returns `survivors`, appends no successor, and quarantines;
4. `unknown`, freeze error, or terminate error quarantines even if a later proof says empty;
5. dirty tree or HEAD/ancestry drift after a proven-empty result quarantines;
6. concurrent handoff grants at most one draining/reservation path and the loser gets retryable
   `WORKTREE_OCCUPIED`;
7. retry after a lost successful response returns the original reservation without re-running the fence;
8. invalid scope/path/state/process identity refuses before fencing;
9. `confirmHeld` persists `executionNonce` and removes `reservationNonce`;
10. `failPending` is exact-nonce, idempotent, and leaves no free/held phantom state.

**Verification:** focused `deliveryLeaseService` + `deliveryStore` suites with one worker, then `npm run typecheck`
and `git diff --check`. The executor must stop without editing if repository evidence requires a decision outside
this contract.

### T7 fenced handoff closure

T7 now persists `held -> draining` before any fence operation, performs freeze/terminate/prove-empty outside every
Delivery, worktree, and SQLite lock, and reserves a successor only after exact full-holder and clean linear-HEAD
revalidation. Fence uncertainty, survivor processes, dirty state, or identity drift quarantines instead of
creating a successor. Reservation confirmation carries the execution nonce, and failed spawn compensation is
exact-nonce and receipt-idempotent. The production fence remains unavailable on this host, so the public join path
still fails closed; only unit tests inject a certified fence.

Adversarial R1 found retryability and partial-holder comparison gaps; the accepted fix makes in-flight states
retryable and structurally fences the complete holder. R2 then reported a replay gap but had mistaken the current
Delivery for the immutable `result_json` stored in the transaction-A operation receipt. Coordinator reproduction
proved the receipt retains the original holder after a nonce-preserving live-record mutation; R3 explicitly
retracted R2 and returned **ACCEPT**. Integrated on `main` through `f87894f`; final coordinator full verification is
recorded after this bookkeeping commit.

### T8 implementation contract — bounded lease observation

T8 adds a read-only condition watcher and its Bridge surface. It does not acquire, reserve, release, reconcile,
or mutate a Delivery; it does not certify the process fence or enable `delivery_join`. The watcher must remain
usable while the production fence is unavailable.

**Runtime/model triage:** ambiguity is low because this contract fixes the API and algorithm; implementation spans
six files with a narrow Bridge/Workspace seam. Concurrency risk is medium because a long request must not hold or
queue behind acquisition locks; security risk is low but the response must not expose holder nonces, process
identity, principal, or quarantine evidence. Use the declared `codex-executor` at `gpt-5.6-sol` medium with serial
tests. The coordinator owns every design choice below.

**Owned files:** `src/delivery/leaseService.ts`, `src/bridge/tools.ts`, `src/workspace/Workspace.ts`,
`test/unit/deliveryLeaseService.test.ts`, `test/unit/bridge.test.ts`, and the two exact tool-inventory count
assertions in `test/unit/auth.test.ts`. No other auth-test changes and no store schema, process-fence, AgentManager,
GitDelivery, config, ledger, or other test edits.

**Internal API and result contract:**

- Export `waitForDeliveryLease(store, input, timing?)` from `src/delivery/leaseService.ts`; `store` is the read-only
  `Pick<DeliveryStore, "get">`, not a `DeliveryLeaseService` instance, so Workspace does not construct a fake
  handoff service with unusable production dependencies.
- `input` is `{ deliveryId: string; afterVersion?: number; timeoutMs: number }`. Reject a non-integer/non-positive
  timeout or a timeout above 300,000 ms; reject an invalid `afterVersion` rather than clamping it. The Bridge schema
  enforces the same bounds with `delivery_id`, optional `after_version`, and required `timeout_ms`.
- `timing` is an internal test seam with monotonic `now()`, `sleep(ms)`, and `pollMs`; production defaults are
  `Date.now`, an ordinary cancellable-by-completion timer sleep, and 100 ms. Polling always sleeps at most the
  remaining deadline and leaves no timer after return.
- Return only `{ deliveryId, outcome, waitedMs, version?, state? }`, where outcome is `released`, `quarantined`,
  `disappeared`, `changed`, or `timeout`. Never return `holder`, reservation/execution nonce, process identity,
  principal, or free-form quarantine reason/evidence.
- Classification order on every successful read is binding: missing record -> `disappeared`; `quarantined` ->
  `quarantined`; `free` -> `released`; if `afterVersion`/the occupied baseline differs from the current version ->
  `changed`; otherwise continue watching the occupied state. A missing `afterVersion` adopts the first successfully
  read occupied record version as its baseline. `changed` prevents a release followed by another acquisition
  between polls from becoming an invisible lost wakeup; it grants no lease and callers must re-read/retry.
- A transient `DeliveryStoreBusyError` is observation contention, not disappearance or release: keep polling until
  a successful classification or the original deadline. Surface every other store/corruption error. Timeout
  returns the last successfully observed public version/state when available.
- The watcher calls only `store.get` and `sleep`. It must never enter `withDeliveryLock`, `withWorktreeLock`, a
  SQLite write transaction, or any acquisition queue. Add `version` to the minimal detail of retryable
  `WORKTREE_OCCUPIED` errors so callers can pass an exact `after_version`; do not add any secret holder fields.

**Bridge/Workspace wiring:**

- Add an optional typed `waitForDeliveryLease` dependency to `BridgeDeps`; register `wait_for_lease` on every
  Bridge and fail visibly when the dependency is absent, matching existing optional tool seams.
- Workspace wires the dependency directly to its canonical `DeliveryStore`. The handler returns the structured
  minimal result as JSON and performs no caller-name authorization by display-name equality.
- Update the exact Bridge tool inventory/count and add an end-to-end forwarding/schema test. Do not change any
  existing wait-for-agent/output concurrency behavior.

**Required deterministic tests:**

1. `wait_for_lease is bounded and cannot block an independent release`: start from a real held Delivery, pause the
   injected sleep, complete an independent `store.update` to `free` before releasing that sleep, then require the
   waiter to return `released` without exposing holder data;
2. immediate `free`, `quarantined`, and missing records return their exact terminal outcomes without sleeping;
3. an `afterVersion` mismatch returns `changed` immediately, including when a release/reacquire has left the
   Delivery occupied again;
4. fake monotonic time proves the exact deadline is bounded and the final sleep is capped to the remaining time;
5. transient store-busy observations retry within the same deadline, while non-busy errors surface;
6. the real MCP client lists/calls `wait_for_lease`, forwards snake-case input correctly, enforces bounds, and
   returns no holder/nonce/process/principal/reason fields.

**Verification:** run the lease-service, DeliveryStore, and Bridge suites serially with one worker, then
`npm run typecheck` and `git diff --check` from the T8 base. Commit only the owned paths with a `t-0b5723` message
and notify `codex`; stop before editing if repository evidence contradicts this contract.

### T8 R1 correction contract — cancellation and bounded fanout

R1 found that an individually bounded watcher was still an unbounded workspace resource: the MCP callback exposes
`RequestHandlerExtra.signal`, but the handler ignored it, and every concurrent call created an independent SQLite
poll loop. The correction remains within the existing six owned implementation/test files and makes these binding
choices:

- `waitForDeliveryLease` accepts an optional `AbortSignal` as a distinct control argument after the internal timing
  seam. It calls `throwIfAborted` before and after every `store.get`, and before sleeping, so cancellation can never
  start another database read or return a stale terminal classification.
- The production sleep accepts that signal and owns its timer plus one abort listener. Normal completion and abort
  both clear the timer/listener exactly once; abort rejects with the signal's standard reason/`AbortError`. Injected
  test sleeps receive the same signal. No `cancelled` lease outcome is invented because cancellation belongs to the
  MCP request, not Delivery domain state.
- `BridgeDeps.waitForDeliveryLease` receives `(input, signal)`, and the `wait_for_lease` callback must use its second
  SDK `extra` parameter to forward `extra.signal`. Workspace forwards it to the canonical watcher.
- Add a non-queuing gate in `src/bridge/tools.ts`, stored in a `WeakMap<AgentManager, Gate>` so stateless per-request
  tool registration shares one workspace lifetime. At most four lease waits may run globally and at most one may
  run for a given `delivery_id`. A duplicate Delivery or full global gate refuses immediately with a stable visible
  error; every success, error, timeout, and abort releases exactly its own slot in `finally`. There is no hidden
  acquisition queue and no coalesced result that could mix different baselines/deadlines.
- With the fixed 100 ms production poll interval, the policy bounds one Delivery to ten reads/second and the whole
  Bridge to forty reads/second while still allowing four independent Deliveries to be observed in parallel.

**Required regression tests:** deterministically abort while the watcher is sleeping and prove its timer/listener
cleanup and read count remain unchanged afterward; abort through the real MCP client and prove the SDK signal reaches
the dependency; hold one same-Delivery wait and prove a duplicate is refused without invoking the dependency; hold
four distinct waits and prove a fifth is refused without invoking the dependency; release/abort all holders and
prove slots are reusable. Re-run the existing 105-test matrix, typecheck, diff-check, and full verification. The
executor must commit the correction separately and stop on any new scope/design conflict.

### T8 bounded watcher closure

T8 now exposes `wait_for_lease` as a read-only, monotonic, finite watcher over canonical Delivery state. It detects
release, quarantine, disappearance, and occupied-version changes without holding or entering an acquisition,
worktree, or SQLite write lock; results omit holder/process/nonce/principal/quarantine evidence. Transient store
contention remains within the original deadline, and callers can carry the observed `WORKTREE_OCCUPIED` version to
avoid a release/reacquire lost wakeup.

R1 found that cancelled and concurrent MCP requests could multiply synchronous SQLite polling after callers had
gone away. The accepted hardening forwards the SDK `AbortSignal`, clears timer/listener state without a registration
race, prevents post-abort reads, and uses a non-queuing workspace gate of four independent Deliveries and one waiter
per Delivery. R2 returned **ACCEPT** after the coordinator added the registration-window regression. Integrated on
`main` through `1efc2f5`; final coordinator full verification is recorded after this bookkeeping commit.

### T9 implementation contract — crash-safe system verification lease

T9 applies only to canonical Delivery-backed `verify_task` calls. The legacy exactly-one-agent compatibility path
keeps its existing liveness guard and checkout lock. A canonical call must resolve its exact linked GitDelivery and
use that projection's normalized `worktreePath`; branch-name inventory is not an authority for Delivery verification.

**State and identity.** System verification is a lease substate, not a `DelegationSegment`. Appending a verifier
segment would either close an inactive writer permanently or require reopening immutable history. Extend
`DeliveryLease` with an optional durable verification intent containing a random lease nonce, a per-Workspace
verifier-owner epoch, the Bridge-resolved actor, the subject tail segment id, delivered HEAD, optional temporary
checkout SHA, start time, operation id, and an exact resumable snapshot of the prior `free` or `held` lease. While
verification runs, `lease.state` is `verifying`; a prior held holder remains recorded for provenance but grants no
runtime authority. Completion restores the prior `held`/`free` shape with a fresh `changedAt`. Pending, draining,
verifying, and quarantined leases are never silently repurposed.

Before the verifying CAS, re-read the Delivery and its linked GitDelivery under the canonical worktree-path mutex.
Re-prove contiguous unique segments, resolve the tail, and, when a holder exists, require the complete holder to
name that exact tail. Check liveness for the tail's **current `executionAgent`**, even for a free lease; never inspect
segment zero. A live current execution returns retryable `WORKTREE_OCCUPIED`. Require a clean canonical worktree,
the checked-out HEAD equal to the current immutable `taskRef`, and the linked projection still name this Delivery,
branch, and realpath. The SQLite version CAS is the cross-process winner; a loser performs no checkout.

The current host's unavailable `ProcessFencePort` remains honest. T9 does not claim T11's dead-holder reconciliation
or prove independent process absence: it preserves the accepted T9 boundary of managed current-holder liveness and
does not call `freeze`/`terminate`. A real live successor is excluded now; detached/ambiguous death remains the
explicit T11 concern.

**Checkout protocol.** Put Delivery verification behind a dedicated service owned once by `Workspace`, using the
same canonical path key as WorktreeManager `ensure`/`remove`. Expose a path-based WorktreeManager mutex and make the
existing agent-path helper delegate to it, so verification, creation, reuse, and deletion serialize on one key. The
service owns the mutex for the complete checkout/test/restore interval; it must not hold a SQLite transaction or the
Delivery service's process-local mutation mutex while tests execute.

Before every `git checkout --detach --force <sha>`, persist that SHA as the intent's temporary checkout with an exact
nonce/owner/version CAS. A crash is therefore safe on either side of the checkout: recovery accepts a clean observed
HEAD equal to the delivered SHA or the recorded temporary SHA. Restoration performs the existing hard reset and
untracked clean, checks that `taskRef` still resolves to the recorded delivered SHA, checks out that branch, and
re-proves clean HEAD equality. Dirty state, branch movement, a third HEAD, projection drift, or an uncertain CAS
quarantines with evidence; none is called restored.

The service stamps a fresh in-memory owner epoch per Workspace construction. A `verifying` intent owned by the same
epoch is active and returns retryable occupied. A different epoch is an interrupted prior host session: recover the
clean matching checkout, restore the saved lease, append an interrupted/retryable event, and return a retryable
interruption so the caller deliberately retries. Normal callback failure also restores and records interruption;
if safe restoration or its persistence fails, surface an `AggregateError` and retain/quarantine the evidence rather
than hiding the original failure.

Write the existing SHA-bound verification record only after all checks and after a delivered-HEAD restore has been
proved. Then complete the lease with an append-only Delivery event containing `refSha`, `treeSha`, verdict,
verification-record integrity hash, and record path. Completion must exact-match nonce, owner epoch, subject segment,
delivered HEAD, and the resumable prior lease. Both ACCEPT and BLOCKED release the system lease; an exception never
publishes a successful completion event.

**Segment history and scope.** Delivery-backed verification uses the canonical `segments[]` directly, not the
lossy legacy fixer-attempt adapter. Prove every boundary before behavior tests: contract base to first grant, each
segment grant to its release/current end, each release to the next grant, and the final segment end to delivered
HEAD must be ancestor-linear. A missing/non-ancestor boundary is a blocking `non_linear_segment_history` finding,
never a skipped range. For `implementer`, `fixer`, and `recovery`, diff that segment's own grant/end range and check
every file against its normalized `ownsSubset`; invalid/escaping authority fails closed. Reviewer/verifier segments
create no write range in T9. T10 remains responsible for their decisive read-only postconditions.

**Required implementation surface.** Keep production and tests within
`src/delivery/{types,store,leaseService,verifyAdapter}.ts`, `src/worktree/WorktreeManager.ts`,
`src/bridge/{verifyTask,tools}.ts`, `src/workspace/Workspace.ts`, and focused unit tests for those modules. A separate
small Delivery verification service module is allowed only if it owns the complete lifecycle above and avoids
duplicating Delivery/GitDelivery authority. Do not alter `tachyon.yml`, config defaults, agent spawning, reviewer
semantics, quarantine recovery policy, or GitDelivery phase transitions.

**Required regressions.** Prove: a live tail successor is refused while a dead segment-zero agent is irrelevant;
two contenders yield one verifying CAS and zero checkout by the loser; acquisition sees verifying as occupied; a
crash at delivered-before-checkout and at the recorded temporary SHA restores and records interruption; dirty and
third-HEAD recovery quarantine; branch/projection drift quarantines; completion restores the exact delivered branch
and prior lease and records the integrity hash; three-plus linear segments use their own write scopes; a nonlinear
adjacent boundary blocks before behavior execution; and legacy verification behavior remains green. Run the focused
Delivery/verifyTask/Bridge/Workspace/Worktree suites serially, then typecheck, diff-check, and `npm run verify:full`.

### T9 R1 correction contract — atomic evidence publication and zero-write authority

R1 found two accepted blockers in `7842960`. Fix only these boundaries plus the two adjacent fail-closed advisories
below; do not redesign the verification lease.

**Atomic verification record publication.** `writeVerificationRecord` must never open or truncate the canonical
target. Serialize the complete JSON plus trailing newline into a unique sibling temporary file opened exclusively,
flush the file contents with `fsync`, close it, then atomically rename it to the canonical path. Sync the containing
directory where the platform supports directory fsync; an unsupported Windows directory-fsync operation may be
documented and skipped, but a normal write/fsync/rename failure must propagate. On every caught failure, remove only
the exact temporary pathname created by that call; never glob or delete another operation's temp or canonical
record. A crash before rename may leave an inert sibling temp, but never a partial canonical record; a deliberate
retry ignores unrelated temp files and can publish normally. Preserve the existing verification-scope conflict
check before replacement, so an unreadable/different canonical record remains fail-closed and a different identity
is never overwritten.

Exercise the production writer, not an in-memory `publish` mock: inject/fake a failure at the rename boundary after
the sibling temp has been completely written, prove the canonical target is absent or remains its prior valid bytes,
prove only the current call's temp is cleaned on the caught path, leave an unrelated partial sibling temp, then retry
the real canonical `verifyTask` flow and prove it publishes a valid scoped record and completes the Delivery. Also
cover a valid record published before a simulated completion interruption: next-epoch recovery plus deliberate retry
must converge without treating the orphan artifact as authoritative completion or wedging the Delivery.

**Writer authority precedes the zero-diff optimization.** For every `implementer`, `fixer`, and `recovery` segment,
normalize and validate `ownsSubset` and prove it is within the immutable contract before checking whether grant=end.
Grant=end skips only `git diff`; it never skips authority validation. Add zero-write escaping, absolute, and widened
scope cases and prove each blocks before the behavior runner.

**Adjacent fail-closed closures.** The exported `verifyTask` function itself must reject any `deliveryId` call that
lacks the Workspace-owned `deliveryVerification` service; relying only on the Bridge wrapper leaves a future direct
caller able to take the destructive legacy checkout path. Keep legacy agent-only calls unchanged. Exact projection
validation must also require `GitDelivery.workspaceId === Delivery.workspaceId`; add a drift regression that refuses
before checkout. These are T9 authority checks, not T15 phase-policy work.

Run the focused nine-suite serial matrix recorded in R1, `npm run typecheck`, `git diff --check`, and
`npm run verify:full`. Commit corrections in one new plain commit by explicit pathspec; never amend/rewrite and never
stage `tachyon.yml`.

### T9 R2 correction contract — cross-process record CAS and owned temp cleanup

R2 (`8e68d23`) proved that atomic rename alone is insufficient: two legacy identities can both pass the preflight
and the second POSIX rename replaces the first. Do not add a crash-stale lockfile protocol. Serialize the complete
canonical-record conflict check plus sibling-temp publication in one short cross-process SQLite `BEGIN IMMEDIATE`
critical section, using a dedicated workspace-local publication database under `.tachyon/`. Configure a bounded
busy timeout, `journal_mode=DELETE`, and `synchronous=FULL`; always COMMIT/ROLLBACK and close in `finally`. The
transaction contains only synchronous record read/parse/scope comparison, temp write/fsync/close, rename, and
directory fsync — never behavior tests, Git operations, or Delivery lease work. SQLite owns crash release; there is
no durable application lock row or stale-owner recovery policy.

Inside that serialized section, retain the existing rules: absent target may publish; valid same-scope target may
be atomically replaced by the new complete record; unreadable or different-scope target returns
`VERIFICATION_RECORD_CONFLICT` and is never renamed over. Thus legacy different identities targeting the same
`<refSha>.json` cannot both succeed, while sequential same-scope re-verification remains supported. If the verified
runtime cannot provide the SQLite lock domain, fail closed with a clear publication-unavailable error rather than
falling back to check-then-rename.

Track temporary-file ownership only after `openSync(..., "wx")` succeeds. An exclusive-open collision performs no
unlink and preserves the pre-existing sibling byte-for-byte. On a later publication failure, attempt to remove only
the temp created by this call. Cleanup failure must not replace the primary write/fsync/close/rename/dir-fsync error:
throw an `AggregateError` carrying both in stable primary-then-cleanup order. Never claim cleanup succeeded.

Add deterministic regressions through the real publisher: two concurrent child processes/barriered workers publish
different legacy identities to one SHA and exactly one succeeds while the loser receives
`VERIFICATION_RECORD_CONFLICT`; the winner's returned bytes remain canonical. Add an exact `wx` collision test that
preserves the unowned sibling, and a primary publication failure plus cleanup failure test that exposes both errors.
A tiny test helper process is allowed under `test/helpers/`; exporting the internal record writer for this helper is
allowed, but do not add a Bridge tool or public user-facing API. Preserve every R1 regression.

Run the R1 nine-suite serial matrix, `npm run typecheck`, `git diff --check`, and `npm run verify:full`. Commit only
the correction paths in one new plain `t-0b5723` commit; no amend/history rewrite and never stage `tachyon.yml`.

### T9 R3 correction contract — transaction error causality and forcing race proof

R3 (`485d50a`) confirms the SQLite serialization itself is sound and narrows the remaining work to error composition
and the concurrency regression. Do not change publication semantics or introduce another lock mechanism.

Refactor the transaction wrapper so no `finally` operation can replace an earlier exception. Track transaction
stage, return value, and failures explicitly. Initialization/PRAGMA/`BEGIN IMMEDIATE` failure is the primary clear
`verification record publication unavailable` error with the original cause. A callback/conflict/write failure or
COMMIT failure is the primary error. Whenever BEGIN succeeded and COMMIT did not, attempt ROLLBACK and retain any
rollback failure. Always attempt close and retain any close failure. After cleanup, throw the sole failure directly
or an `AggregateError` in stable `primary`, `rollback`, `close` order; on a successful COMMIT with close-only failure,
surface that close failure rather than reporting success. Busy/BEGIN failures remain publication-unavailable and
keep their original cause. No rollback/close exception is swallowed.

Provide a narrow internal test seam for the publication database factory/lifecycle and a post-conflict-check hook;
it is not a Bridge or user API. Add deterministic unit cases for BEGIN/busy failure, callback/conflict plus rollback
failure, COMMIT plus rollback failure, and primary+rollback+close failure, asserting exact order and causes.

Strengthen the real two-process test: both children signal ready before calling the writer. The first process to
reach the post-conflict-check hook writes its marker and blocks on a parent-controlled release file while still
holding `BEGIN IMMEDIATE`. Prove the other ready process cannot reach its own post-check marker during a bounded
window. Release the winner; it publishes, then the loser enters, observes the different canonical identity, and
returns `VERIFICATION_RECORD_CONFLICT` without reaching the hook. Keep the one-success/one-conflict and canonical
winner-byte assertions. This forcing protocol must fail if the SQLite wrapper is removed and old check-then-rename
behavior returns.

Run the R1 nine-suite serial matrix, `npm run typecheck`, `git diff --check`, and `npm run verify:full`. One new plain
`t-0b5723` commit by explicit pathspec; no amend/history rewrite and never stage `tachyon.yml`.

### T9 crash-safe verification lease closure

T9 now acquires a durable `verifying` system lease for canonical Delivery-backed `verify_task`, resolves the exact
linked GitDelivery/workspace/canonical realpath, excludes the live tail rather than segment zero, persists every
temporary checkout before mutation, restores the delivered branch before evidence publication, and preserves or
quarantines the prior lease with complete identity evidence. Canonical scope verification proves ancestor-linear
boundaries and validates every writer segment's normalized authority, including zero-write segments; reviewer and
verifier segments remain no-write ranges pending T10 postconditions. Direct canonical calls without the
Workspace-owned lease fail closed; the legacy agent-only path remains compatible.

Verification records publish complete fsynced bytes through a sibling temp under a short crash-released SQLite
`BEGIN IMMEDIATE` transaction. Cross-process conflict check and rename are serialized, different legacy identities
cannot overwrite one another, same-scope retries remain supported, temp ownership is exact, and transaction/file
cleanup errors preserve stable causal order. Four adversarial review rounds closed crash-wedge, zero-write scope,
cross-process overwrite, temp ownership, lifecycle-error, and non-forcing-test findings. Final verdict: **ACCEPT**
(`9b76e0c`) over implementation head `d3f0758`.

Coordinator closure verification on `9b76e0c`: `npm run typecheck`, `npm run verify:full`, and `git diff --check`
passed; full verification reported 300 files, 3,361 passed, and 3 skipped. The only remaining working-tree change is
the maintainer-owned `tachyon.yml`, deliberately excluded from every T9 commit.

### T10 implementation contract — exclusive reviewer postconditions

T10 is a bounded DeliveryLeaseService and AgentManager slice. It does not add persistent-identity bound executions
(T13), GitDelivery review projection transitions (T15), recovery policy (T11/T12), or enable the unavailable
production ProcessFence. The existing `delivery_join` route is the only reviewer acquisition path and never creates
a fallback worktree.

**Measured runtime hints.** Local CLI help confirms Codex supports `--sandbox read-only`; Claude and Grok support
`--permission-mode plan`. Apply those flags only to Delivery joins whose role is `reviewer`, before prompt
composition, and persist the effective safe command for that bound execution. If the supplied command already
requests a conflicting sandbox/permission mode or any bypass flag, refuse the reviewer spawn rather than silently
claiming a hint. OpenCode and unknown runtimes have no measured shell-level read-only equivalent in this slice: keep
their command unchanged and emit a clear advisory. These hints reduce accidents only; no verdict trusts them.

**Reviewer grant.** Reuse `DeliveryLeaseService.acquire`/`handoff`; do not add another acquisition state machine.
For role `reviewer`, require `ownsSubset` to be exactly empty and pin the segment to the requested HEAD. Before a
reviewer reservation is persisted, require the canonical worktree/ref to be at that HEAD, the tracked worktree clean,
and the index tree equal to `<HEAD>^{tree}`. Pending/draining/verifying/quarantined remain retryable/refused under the
existing lease rules. The reviewer segment records role `reviewer`, empty authority, and the pinned grant SHA.

**Review completion.** Add one idempotent `completeReview` service operation taking Delivery id, canonical worktree,
expected reviewed HEAD, submitted verdict `ACCEPT|FINDINGS`, Bridge-resolved actor, and stable operation id. Require a
held open tail reviewer segment, an exact full holder with process identity/execution nonce, empty authority, and an
expected HEAD equal to its grant. Persist `held -> draining` with an intent/receipt, then perform
freeze/terminate/`proveEmpty` outside every Delivery/worktree/SQLite lock. Only `proven_empty` without fence errors
may continue. Retry after lost drain/completion responses must replay the same intent; a different intent refuses.

Under Delivery-then-canonical-worktree lock, revalidate the exact draining holder and inspect twice. Both observations
must show checkout HEAD and immutable task ref at the pinned SHA, index tree equal to the pinned commit tree, and no
tracked worktree diff. Untracked files are not verdict-bearing. On exact equality, atomically close the reviewer
segment at the same SHA, set outcome `completed`, release the lease to `free`, and append the sole authoritative
`review_completed` event with verdict and reviewed SHA. Both ACCEPT and FINDINGS use this path.

Any fence uncertainty, HEAD/ref movement, staged/index mutation, tracked worktree mutation, holder drift, or missing
inspection capability records `review_invalid`/quarantine evidence while preserving the holder and open reviewer
segment; it never appends `review_completed` and never records an authoritative ACCEPT. Surface structured
`DELIVERY_QUARANTINED`, and aggregate a quarantine-persistence failure with the original cause. Do not reset, clean,
or discard reviewer mutations.

**Implementation surface.** Production paths are limited to `src/delivery/leaseService.ts`,
`src/delivery/types.ts` only for review input/result types if necessary, and `src/agents/AgentManager.ts`. Tests stay
in `test/unit/deliveryLeaseService.test.ts` and `test/unit/agentManager.test.ts`; a small pure command-hint helper may
live beside AgentManager only if it materially reduces parsing risk. No Bridge tool, Workspace wiring, config change,
GitDelivery mutation, or `tachyon.yml` edit in T10.

**Required regressions.** Prove reviewer nonempty authority refuses; clean empty-authority reviewer grant is pinned;
verifying excludes review; Codex/Claude/Grok receive measured flags, conflicting bypass/modes refuse, and unsupported
runtimes remain advisory-only. Prove clean ACCEPT and FINDINGS close/release with one authoritative event; HEAD,
task-ref, index-only, and tracked-worktree mutations each quarantine without `review_completed`; an untracked-only
file does not invalidate; holder drift and fence unknown quarantine; lost drain/completion responses replay exactly;
and no process-fence or spawn work occurs under durable locks. Run the focused DeliveryLeaseService + AgentManager
suites serially, `npm run typecheck`, `git diff --check`, and `npm run verify:full`.

### T10 R1 correction contract — effective reviewer argv

R1 report `5fc0b45` correctly proves that whitespace scanning plus end-appending can place a nominal safety flag
after `--` or on another shell command. Replace that transformation with the existing launch-preflight shell model;
do not grow a second regex/tokenizer. The parser may expose the runtime token's exact source end and whether every
word is literal/static, while preserving its current callers. Reviewer commands must refuse when parsing is
ambiguous, when shell control/redirection/substitution/expansion can change the effective argv, or when one supported
runtime argv cannot be proved. Literal control-looking text inside a single-quoted positional argument is data, not
composition.

For Codex, Claude, and Grok, inspect runtime options only before the first literal `--`. Recognize both Codex
`--sandbox[=]` and `-s[=]`; accept only `read-only`, and refuse `--full-auto` plus active bypass flags. For Claude and
Grok, accept only `--permission-mode[=]plan` and refuse active bypass flags. Bypass-looking text after `--` is
positional and does not itself refuse. If no safe mode is present, insert the fixed safety option immediately after
the structurally located runtime binary, so it is necessarily before every runtime argument and `--`; never append
it to the command tail. Preserve an already-safe literal command byte-for-byte. The exact transformed command remains
the command passed into spawn composition and persisted in the ledger.

The R1 fix may additionally own `src/runtime/launchPreflight.ts` and
`test/unit/runtimeLaunchPreflight.test.ts` solely for shared structural-token metadata; no other scope expands. Add
production-path regressions for quoted safe values, `--`, `env`/`npx` wrappers, pipelines/`&&`/`;`/redirection,
command or parameter expansion, Codex short sandbox and `--full-auto`, bypass-looking positional text, and a real
shell argv-capture executable proving the supported runtime—not a sibling process—receives the inserted flag. String
containment alone is not acceptance evidence. Re-run the focused AgentManager + launch-preflight + lease suites
serially, `npm run typecheck`, `git diff --check`, and `npm run verify:full`.

### T10 R2 correction contract — proven wrapper boundary

R2 report `ac097eb` correctly shows that “skip every leading wrapper flag” is not an executable-boundary proof.
Replace the generic launcher loop in the shared launch parser with a small explicit grammar. It may accept leading
assignments, chain `env` into one of `npx`/`pnpx`/`bunx`, and then return exactly one runtime token; any unknown option,
missing operand, shell-evaluating mode, or ambiguous boundary returns no parse and reviewer join refuses before
reservation.

The measured minimum grammar is: `env` assignments plus static `-i/--ignore-environment` and the operand-taking
`-a/--argv0`, `-C/--chdir`, `-f/--file`, and `-u/--unset` in exact separate or documented long-`=` form. Refuse
`-S/--split-string` and every unlisted `env` option. For `npx`, accept `-y/--yes`, `--no`, `--workspaces`,
`--include-workspace-root`, `-p/--package` and `-w/--workspace` with a separate operand or long-`=` form, plus a
literal wrapper `--` boundary; refuse `-c/--call` and unlisted options. For `pnpx`, accept static `--allow-build` and
`--package` operands, reporter operands, and ordinary package-first invocation; refuse `-c/--shell-mode` and unknown
options. For `bunx`, accept static `--bun`, `--no-install`, `--verbose`, `--silent`, and `-p/--package` operands;
refuse unknown options. Supporting additional wrapper forms is unnecessary in T10; fail closed with a clear reviewer
command error. Parser/preflight behavior for a direct runtime remains unchanged.

Recognize Codex sandbox as `--sandbox VALUE`, `--sandbox=VALUE`, `-s VALUE`, `-s=VALUE`, or attached `-sVALUE`.
Exactly one sandbox declaration is permitted: preserve one literal `read-only` form byte-for-byte, refuse every other
value, missing value, and every duplicate before reservation. Apply the same single-declaration rule to
Claude/Grok `--permission-mode`; the inserted default is not a declaration from the supplied command.

Add parser and AgentManager production-path tests for every accepted/refused wrapper class, including the exact R2
`env --argv0/-a/-f` and `npx -p/--package/--package=` reproductions, wrapper chains, missing operands, and
shell-evaluating modes. Add real executable argv capture through real `env` and deterministic fake `npx`/`pnpx`/`bunx`
wrappers that consume their declared operands before invoking the fake runtime; prove the safety option lands on the
runtime argv. Cover `-sread-only`, `-sworkspace-write`, and duplicates spanning short-attached/separate/long forms.
Run the same focused three-suite matrix, `npm run typecheck`, `git diff --check`, and `npm run verify:full`.

### T1 lock protocol redesign — SQLite decision

Five adversarial rounds found successive crash windows in application-managed owner/fence/claim lockfiles. The
maintainer approved replacing that family rather than patching another marker. T1 now uses a SQLite transaction as
the only physical cross-process exclusion mechanism: short `BEGIN IMMEDIATE` transactions, durable receipts for
retry after a lost response, and capability-gated local lock-domain validation. The long-lived Delivery lease
remains domain state. The experimental lockfile commits are not accepted or integrated.

### SQLite runtime capability spike — GO

The actual VS Code extension-host binary (`~/.vscode-server/bin/4fe60c8b…/node`) reports Node `v24.15.0` and
exports `node:sqlite` (`DatabaseSync` and `StatementSync`). A disposable `/tmp` smoke using that exact binary
opened a database, selected `journal_mode=DELETE`, set `synchronous=FULL`, ran `BEGIN IMMEDIATE` + a parameterized
write + `COMMIT`, read the committed row, and cleaned up the database/journal. The workspace filesystem reports
`ext2/ext3`. This is GO evidence for a capability-gated implementation; the production adapter must still refuse
unsupported extension runtimes and unvalidated lock domains.

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Prepared delegation — T1 (T0.2 reconciled; ready)

- **Runtime/model triage:** Codex `gpt-5.6-sol` with high reasoning. T1 is a bounded code task but contains
  cross-process locking, stale-owner proof, CAS, immutable-state enforcement, and crash recovery; low/fast effort
  is inappropriate. Independent review should use another model family when Claude capacity returns, otherwise a
  fresh Codex high reviewer with an explicit adversarial-only contract.
- **Owns:** `src/delivery/types.ts`, `src/delivery/store.ts`, `test/unit/deliveryStore.test.ts`, plus the canonical
  generated behavior stub only.
- **Behavior gate:** `DeliveryStore recovers a provably stale lock while preserving immutable append-only state`.
- **Done condition:** new DeliveryStore/types exist with no Workspace/Bridge/spawn wiring; focused tests and
  typecheck pass; commit references `t-0b5723`; full parent verification remains the coordinator gate.
- **Guardrail:** do not start until T0.2 records PROVEN/PARTIAL/NOT_VIABLE and the plan is reconciled to that
  empirical result. No implementation may silently weaken `proven_empty` or process-fence capability semantics.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

# T1 SQLite DeliveryStore closure — 2026-07-10

- Replaced the lockfile backend with a workspace-local SQLite store using short `BEGIN IMMEDIATE` transactions,
  CAS versions, immutable/append-only validation, structured busy/unsupported errors, and intent-fingerprinted
  operation receipts.
- Added fail-closed runtime/filesystem capability detection and a transactional, idempotent migration of legacy
  Delivery JSON records. Concurrent migrators converge under the SQLite write lock and archive legacy data only
  after proving durable equivalence.
- Adversarial reviews R1–R3 closed legacy invisibility, runtime loading, receipt collision, concurrent marker, and
  archive-rename races. Final verdict: ACCEPT (`c56042a`).
- Integrated on `main` through `96942f7`; `npm run verify:full` passed (295 files, 3263 tests, 3 skipped).
- The superseded lockfile working copy remains preserved in stash
  `pre-sqlite delivery-store lockfile work t-0b5723` until the broader Delivery rollout is complete.

# T2 canonical gated-spawn projection closure — 2026-07-10

- Added opt-in canonical gated-spawn persistence: exactly one Delivery, implementer segment zero, and linked
  GitDelivery projection. Legacy mode remains the default rollout path.
- Spawn failures after runtime creation now run verified compensation without hiding a possibly-live runtime or
  deleting a pre-existing forced worktree.
- GitDelivery moved to a transactionally unique SQLite authority with fail-closed legacy migration and repairable
  JSON mirrors. Real subprocess coverage proves concurrent `open()` converges to one projection.
- Adversarial reviews R1–R4 closed cross-store partial failure, projection uniqueness, migration, crash/mirror,
  compensation, and subprocess cleanup findings.
- Integrated on `main` through `f7476fe`; `npm run verify:full` passed (296 files, 3272 tests, 3 skipped).

# T3 deterministic legacy import closure — 2026-07-11

- Added read-only preview plus fingerprint-bound apply for converting a legacy DelegationRecord and linear fixer
  attempts into canonical Delivery segments with one exact GitDelivery projection.
- Zero/multiple/drifted projections, nonlinear history, changed realpaths/ancestry, and conflicting intent refuse
  before canonical writes.
- A serialized Git reservation makes partial create/link failures resumable by canonical intent rather than a lost
  transport operation id; identical concurrent retries converge to the same Delivery and linked projection.
- Adversarial reviews R1–R5 closed partial-write, stale-inventory TOCTOU, incomplete fingerprint, pending wedge,
  and concurrent retry findings. Final verdict: ACCEPT (`c8a59da`).
- Integrated on `main` through `583f238`; `npm run verify:full` passed (297 files, 3275 tests, 3 skipped).
