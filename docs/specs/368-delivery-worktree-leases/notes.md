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

**Coordinator acceptance A3.** The first R2 implementation `0baaf67` still treats measured pnpx `--allow-build` as
operand-free even though its help declares a package-list operand. Parse it only with one non-option separate operand
or a non-empty long-`=` operand; missing/option-shaped operands refuse. Update the deterministic pnpx wrapper and argv
capture accordingly.

Package-first launchers also hide the effective executable name: `npx codex@<version>` and scoped package specs can
run a supported CLI while the package token itself does not equal the runtime binary. Do not infer package metadata
or bin maps in T10. Expose whether a proven parse crossed `npx`/`pnpx`/`bunx`; if such a parse ends at a runtime token
that has no known Tachyon adapter, reviewer join must refuse before reservation rather than emit the unknown-runtime
advisory. A direct unknown runtime, or one wrapped only by proven `env`, remains unchanged with an advisory. Known
package-first tokens such as literal `npx codex` and known unsupported adapters such as literal `npx opencode` retain
their existing safe/advisory behavior. Add exact package-version/scoped refusals plus direct/env-only unknown guards.

**R3 correction.** Report `01f8fae` proves that the first `env` can currently resolve to another `env`, which is then
misclassified as an unknown direct runtime and launches a supported CLI without its hint. The grammar permits exactly
one `env` layer. Immediately after resolving it, reject another `env` basename (including an absolute-path spelling)
before package-launcher or advisory handling. Preserve the sole allowed chain `env -> npx|pnpx|bunx -> runtime`.
Add parser and production-path refusals for `env env codex`, assignments/options before the second `env`, absolute
second `env`, and `env env npx codex`; prove `prepareDeliveryJoin` and spawn remain untouched. No other wrapper or
unknown-runtime policy changes in this correction. Run the same focused three suites, typecheck, diff-check, and full
verify before the next review.

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

# T10 exclusive reviewer closure — 2026-07-11

- Added empty-authority exclusive reviewer segments, pinned review completion, and decisive task-ref/HEAD/index/
  tracked-tree postconditions after `ProcessFencePort` proves the reviewer execution empty. Mutation or uncertainty
  quarantines the still-open segment and can never append authoritative `review_completed`/ACCEPT.
- Added measured Codex read-only and Claude/Grok plan hints. A shared fail-closed launch parser proves literal argv,
  one permitted `env` layer, an explicit `npx`/`pnpx`/`bunx` operand grammar, the runtime token insertion boundary,
  and a single safe-mode declaration; unsupported direct runtimes remain advisory as explicitly contracted.
- Adversarial R1–R4 closed tail-append/shell-composition, operand-wrapper, attached-short-option, package-spec, and
  nested-`env` escapes. Final verdict: ACCEPT (`9a1a586`).
- Implementation head is `b5d4d98`; coordinator-focused verification passed 385/385 and full verification passed
  300 files, 3500 tests, and 3 skipped before this documentation-only closure.

### T11 implementation contract — dead-holder reconciliation

T11 is a bounded `DeliveryLeaseService` slice. It does not add Bridge/Workspace tools, session-ledger reload binding
(T14), quarantine recovery or actor policy (T12), a production OS `ProcessFencePort`, GitDelivery projection/hygiene,
or any cleanup/reset/prune behavior. It reconciles only a canonical `held` lease. `pending`, `draining`, and
`verifying` remain owned by their existing operation receipts and refuse as in-flight; an already quarantined lease
remains unavailable.

Add a read-only process-identity observation dependency whose input is the exact persisted
`DeliveryProcessIdentity { pid, processStart, bootId }` and whose result is `alive`, `gone`, or `unknown(reason)`.
`alive` means the exact recorded boot/PID/start identity still exists; return an explicit live outcome with the held
Delivery unchanged, no receipt/event, and no fence call. PID absence, boot-generation mismatch, or PID-start mismatch
may be reported as `gone` because the exact recorded process is absent; it still never authorizes release without the
independent fence proof. A missing/malformed holder identity or unavailable/throwing observation is unknown and must
quarantine. Do not infer death from tmux/pane/name liveness.

Add one `reconcileHolder` operation with Delivery id, canonical worktree, Bridge-resolved actor, and stable operation
id. Under Delivery-then-canonical-worktree lock, resolve and match the exact canonical path, require a held open tail,
snapshot the complete lease/holder/process/execution nonce/recorded expected HEAD, and verify holder segment,
executionAgent, and principal match the tail. Perform process observation and all `ProcessFencePort` work outside
every Delivery/worktree/SQLite lock. Reconciliation never calls `freeze` or `terminate`: after exact-process `gone`,
call only the same independent `proveEmpty(executionNonce, canonicalWorktree)` predicate used by handoff. Unsupported
capability, exceptions, `survivors`, or fence `unknown` quarantine.

After `gone + proven_empty`, reacquire Delivery then canonical-worktree lock, revalidate the exact full held lease and
open tail, and inspect the worktree twice. Both observations must be clean including untracked files and exactly at
the lease's recorded expected HEAD; a committed HEAD move is quarantined even if ancestor-linear, because it is
unverified recovery material. Only exact equality atomically closes the tail at that HEAD with outcome `interrupted`,
sets the lease `free`, and appends one `holder_interrupted` event. This is the sole retryable-success transition and
never fabricates completed work, review, or verification.

Unknown identity, absent/malformed durable identity, fence uncertainty/survivors/error, dirty/index/untracked state,
HEAD drift, inspection error, or full-holder drift prevents release and appends one durable
`holder_reconcile_quarantined` event while retaining the current holder, expected HEAD, and open segment. If the
observed lease moved into another owned in-flight state meanwhile, return retryable occupancy and do not overwrite
that flow; if only its held holder drifted, quarantine the current held state. Surface structured
`DELIVERY_QUARANTINED`; aggregate the original safety failure before a quarantine-persistence failure. Never reset,
clean, checkout, terminate, or discard anything.

Use immutable operation receipts for terminal `:interrupt` and `:quarantine` mutations. A lost success response
replays the exact interrupted Delivery; a lost quarantine response replays the same structured refusal; a different
intent on the same operation id refuses. Concurrent identical reconciliation produces one terminal event; a
different concurrent handoff/reconcile winner cannot be overwritten. The live no-op deliberately consumes no
mutation receipt and may be retried later with the same operation id after liveness changes.

Production scope is `src/delivery/leaseService.ts` only; `src/delivery/types.ts` may be used solely if a shared result
type is mechanically necessary. Tests are limited to `test/unit/deliveryLeaseService.test.ts`. Required regressions:
exact live identity unchanged/no fence; gone+proven-empty+double-clean exact HEAD interrupts/releases; reviewer death
does not record ACCEPT; missing/malformed/unknown identity; unavailable/throwing/survivor/unknown fence; dirty,
untracked, index, committed-HEAD, second-observation, and inspection-error quarantine; holder drift and competing
state transition; exact lost-response replay and intent collision; concurrent terminal singularity; quarantine
persistence aggregation; canonical mismatch; and assertions that process observation/proveEmpty run outside locks
while freeze/terminate are never called. Run the focused lease-service suite serially, `npm run typecheck`,
`git diff --check`, and `npm run verify:full`.

**Coordinator pre-review A1.** Implementation `b069563` is mechanically green but must close these contract gaps
before adversarial review:

- A `held` lease with no holder is unknown identity, not ordinary invalid state. Snapshot the complete held lease with
  optional holder and quarantine it while preserving that absence. Valid reconciliation additionally requires no
  `reservationNonce`, nonblank execution nonce, and tail `grantedHeadSha` equal to the lease's recorded expected HEAD.
- Re-resolve and compare the canonical path in every locked phase, including live revalidation and quarantine. A
  changed/missing canonical authority must never mutate under the stale input-path mutex; surface the structured
  mismatch/error and leave the lease fail-closed. The live outcome must revalidate the exact complete lease plus the
  still-open matching tail and grant boundary, not the lease object alone.
- Treat only runtime observation states exactly `alive`, `gone`, or a well-formed `unknown(reason)` as valid. Any
  malformed/foreign result is unknown and quarantines; it must not fall through to the `gone` proof path. Exercise a
  missing observer dependency separately.
- After any quarantine update error, read the immutable `:quarantine` receipt and validate its event/intent/state.
  If the mutation committed and only its response was lost, throw the ordinary replayed `DELIVERY_QUARANTINED` with
  identical detail, not `AggregateError`; aggregate original-before-persistence only when no valid receipt exists.
  A current held state whose holder drifted to a different value or disappeared is still quarantined, whereas a
  transition to `pending`/`draining`/`verifying` remains retryable and is never overwritten.
- Strengthen terminal receipt validation: interrupted replay must prove the intent-bound event, free lease, matching
  closed segment, `outcome=interrupted`, and released/event HEAD; quarantine replay must prove the intent-bound event,
  quarantined lease, and preserved current holder/open tail relationship where a holder exists. Add lost-quarantine-
  response, missing-holder, reservation-nonce, grant/expected-HEAD mismatch, malformed observer result, live-tail
  drift, canonical drift in every phase, in-flight-state, and receipt-shape mutation regressions.

Keep the same two owned paths and verification gates; do not add wiring or recovery policy.

**Coordinator pre-review A2.** The A1 implementation `15785d8` still has a receipt contradiction. Quarantine is
required precisely when holder/tail boundaries may be inconsistent, but its replay currently rejects any preserved
inconsistency. Persist an exact pre-quarantine tail snapshot beside the exact optional holder snapshot in the
`holder_reconcile_quarantined` event; replay must compare event holder/tail/evidence/expected HEAD to the immutable
receipt result, without requiring holder and tail to be mutually valid. This proves preservation while allowing the
invalid relationship that caused quarantine. Add exact retry/lost-response cases for principal, segment-id, missing-
holder, and closed-tail drift; every retry returns the same structured quarantine refusal with one event.

The successful `holder_interrupted` event must persist the complete observed holder plus expected HEAD. Replay must
validate that snapshot has valid process identity/no reservation, its execution nonce matches the event, its
segment/agent/principal match the sole closed tail, and granted/event/released/expected HEAD are equal with
`outcome=interrupted` and a free lease. Extend receipt mutation tests across holder, process/nonce, segment identity,
and grant/release HEAD, not only outcome.

Finally, make the live-tail drift regression truthful. Mutating `grantedHeadSha` on an open tail is forbidden by
`DeliveryStore` and currently turns the test into observer-error quarantine. Use a store-legal concurrent tail
closure (or another deterministic legal seam), assert the mutation itself succeeds, then prove live revalidation
detects the now-closed tail and quarantine replay remains exact. Same two paths and gates; no policy expansion.

# T11 dead-holder reconciliation closure — 2026-07-11

- `reconcileHolder` now distinguishes exact live, gone, and unknown process identities; only `gone` plus the same
  independent `ProcessFencePort.proveEmpty` predicate used by handoff may reach double clean/exact-HEAD inspection.
  Process observation and fence proof run outside Delivery/worktree locks, and reconciliation never freezes,
  terminates, resets, cleans, checks out, or discards work.
- A clean exact dead holder closes its current segment as `interrupted` and frees the Delivery without fabricating
  completion, verification, or review. Missing/malformed identity, fence uncertainty/survivors, dirty state, HEAD or
  holder/tail drift, inspection failure, and malformed receipts fail closed; competing owned states remain retryable
  while a concurrent quarantine remains non-retryable and returns its exact persisted evidence.
- Coordinator rounds A1/A2 and Claude R1 found and closed complete snapshot validation, canonical revalidation,
  truthful tail drift, lost-response receipts, concurrent quarantine determinism, event `segmentId` validation, and
  mid-flight quarantine classification. Final fix `70ecb68`; Claude R2 ACCEPT `e759af0`.
- Final gates after the independent acceptance and the quiet-config mechanical regression `17205a1`:
  `test/unit/deliveryLeaseService.test.ts` 100/100, `npm run typecheck` passed, and `npm run verify:full:quiet` passed
  301 files with 3,559 tests passed and 3 skipped. T11 adds no Bridge wiring, production OS fence, reload binding,
  salvage/abandon policy, or cleanup; those remain T12/T14/T16 concerns.

### T12 implementation contract — explicit quarantine salvage/abandon

T12 is a bounded canonical `DeliveryLeaseService` recovery slice. It does not reset, clean, checkout, remove,
prune, integrate, or mutate a GitDelivery projection; T15 owns projection serialization and destructive Git cleanup.
It does not add rollout/config schema or production Bridge/Workspace wiring; T16 owns those. The slice defines the
trustworthy service interface which that later wiring must call with the Bridge-resolved caller and configured
recovery principals. A direct tool argument, `executionAgent`, segment `principal`, GitDelivery `agent`, or display
name equality is never authority.

**Authority.** Add one pure policy over the canonical Delivery and resolved `DeliveryActor`. An agent may recover
only when its exact resolved name is the Delivery's original agent creator or is present in the trusted
`recoveryPrincipals` dependency. `legacy` and `external` callers are denied. Host-internal `human`, `master`, and
`system` actors remain authoritative, but an agent cannot self-declare those kinds at the later Bridge boundary.
The service performs this policy itself before any fence, Git observation, nonce allocation, or mutation. The
authorization decision is based only on `createdBy` plus configured principals, never on the quarantined holder,
open tail, requested successor, or attribution-only `principal`.

**Recovery inputs and evidence.** Expose separate `salvageQuarantine` and `abandonQuarantine` operations with a
stable `operationId`, canonical worktree, exact caller actor, caller-observed expected HEAD, and exact expected loss
inventory. The inventory is a canonical, duplicate-free, deterministically ordered value containing the observed
HEAD, dirty tracked/index/worktree and untracked paths with status, and the commit SHAs not retained by the
Delivery's immutable base. Obtain it from a trusted `inspectRecoveryWorktree` dependency; never accept the caller's
inventory as the observation. Require two equal inspections while holding the Delivery-then-worktree locks at the
commit boundary, and require both to equal the supplied expectation. Inspection error, malformed/duplicate or
unstable inventory, HEAD mismatch, canonical-worktree drift, lease drift, holder/tail drift, or loss-set drift leaves
the Delivery quarantined and returns a non-retryable structured refusal with no partial segment/event append.

**Exclusive boundary.** Snapshot the exact quarantined lease, holder, open tail, reason, and canonical worktree
under the normal lock order. A recoverable quarantine must retain an exact open holder/tail with a non-empty
execution nonce. Call `ProcessFencePort.capability` and `proveEmpty(executionNonce, canonicalWorktree)` outside all
Delivery/worktree locks. Never freeze or terminate during recovery. Only `proven_empty` can proceed; unavailable,
unknown, survivors, missing holder/tail/nonce, or any snapshot drift remains quarantined. Revalidate the complete
snapshot and canonical path after the proof and immediately before the durable CAS. This deliberately fails closed
for a holder-less system-verification quarantine until a later explicit recovery contract can prove its owner epoch;
T12 must not guess that absence.

**Salvage.** Salvage is non-destructive: it preserves every byte and commit, closes the quarantined predecessor as
`interrupted` at the observed HEAD, appends exactly one open `recovery` segment, and publishes a nonce-bound
`pending` reservation for the requested `executionAgent`/optional attribution-only `principal`. Normalize and prove
the requested `ownsSubset` is inside the immutable Delivery contract. The recovery segment's `grantedHeadSha` is
the observed committed HEAD; its event records the prior quarantine reason, exact holder/tail snapshot, complete
loss inventory, actor, scope, reservation nonce, and stable intent. Dirty state is evidence carried into recovery,
not a verified baseline: the event/type/result must not say verified, accepted, clean, or completed. Existing
`confirmHeld`/`failPending` owns the later spawn confirmation/compensation.

**Abandon.** Add terminal lease state `abandoned`; it is neither released nor acquirable. Abandon closes the open
predecessor as `rejected` at the observed HEAD and records one `quarantine_abandoned` event, but performs no Git or
filesystem deletion. It requires the same actor policy plus a trusted approval resolver dependency keyed by
`approvalId`, resolved actor, and a canonical action digest over Delivery id, expected HEAD, exact loss inventory,
and operation intent. The returned receipt must be an on-disk, tamper-checked, host-resolved `approved` decision,
belong to the same resolved agent requester, and echo the exact digest; pending, denied, foreign-requester,
tampered, unbound, or replayed-for-different-loss approval is refused before mutation. Persist the approval id,
payload hash/action digest, human resolution timestamp/identity, exact loss inventory, and actor in the event so T15
can require this immutable authorization before any destructive cleanup. Marking abandoned never itself deletes
dirty files or unique commits.

**Receipts and failure behavior.** Both operations use one SQLite operation receipt whose intent includes the full
normalized input, actor, expected inventory, and approval id where applicable. Same-operation lost-response replay
must return the exact persisted reservation/abandoned Delivery without rerunning the fence, inspections, approval
resolver, or allocating new ids. Reusing an operation id with any changed action, inventory, actor, scope, execution
identity, approval, or canonical path fails as an invalid receipt. Concurrent salvage/abandon attempts permit one
winner; the loser observes the resulting owned/terminal state and cannot append a second segment or event. Any
error before the CAS leaves the original quarantine byte-for-byte unchanged; an uncertain persistence error is
surfaced with its causal chain rather than reported as a safe recovery.

**Compatibility and observation.** Existing records remain schema version 1. Extend lease-state validation and
wait observation so `abandoned` is a terminal, non-released outcome, while all existing free/pending/held/draining/
verifying/quarantined behavior remains unchanged. No legacy Delivery or GitDelivery behavior becomes enabled.

**Owned implementation paths.** `src/delivery/types.ts`, `src/delivery/leaseService.ts`, and
`test/unit/deliveryLeaseService.test.ts` only. If repository evidence proves the approval receipt cannot be modeled
without changing `src/bridge/approvalRequest.ts`, stop and return the missing interface decision; do not widen scope.

**Deterministic test matrix.** Cover original-creator and configured-principal salvage; deny holder/principal/
execution-name equality, legacy/external, and unconfigured peers; prove fence work occurs outside locks and only
`proven_empty` advances; refuse holder-less, survivor, unknown, capability-missing, canonical-path, lease/tail, HEAD,
dirty-path, unique-commit, unstable-inspection, malformed-inventory, and scope drift without mutation; prove salvage
creates one pending recovery segment with dirty evidence but no verified claim; prove abandon requires exact
host-resolved approved receipt and produces terminal state without any cleanup callback; mutate every approval
binding field independently; prove same-operation replay skips all effects; force salvage-vs-abandon and same-action
two-store races with exactly one event/segment winner; retain existing T5-T11 suite behavior. First reviewable
candidate gates: serial focused DeliveryLeaseService suite, `npm run typecheck`, `git diff --check`, then
`npm run verify:full:quiet` exactly once.

### T12 R1 consolidated correction contract

Candidate `7a9d82fa` is not accepted. Sonnet R1 `cc47254` confirms the coordinator's terminal-state, cross-process
CAS/error, exact-tail, authority-order, locale-canonicalization, and coverage findings. Use Terra medium because the
change is bounded but requires SQLite idempotence and deterministic concurrency proof. Own only:
`src/delivery/types.ts`, `src/delivery/leaseService.ts`, `src/delivery/store.ts`,
`src/delivery/verificationLease.ts`, `test/unit/deliveryLeaseService.test.ts`,
`test/unit/deliveryStore.test.ts`, and `test/unit/deliveryVerificationLease.test.ts`. Do not add Bridge, Workspace,
config, GitDelivery, cleanup, T13, or refactor work.

**Terminal state and store invariants.** Add an explicit non-retryable `DELIVERY_ABANDONED` refusal and use it for
lease acquisition, repeat recovery, and system verification before their generic retryable occupied paths.
DeliveryStore runtime validation must reject unknown lease states and malformed abandoned records. An abandoned
record has no holder, expected HEAD, or verification intent, has at least one segment, and has no open segment.
Schema version remains 1; other states remain compatible. Test immediate terminal wait plus all three non-retryable
entry points and malformed/unknown store records.

**CAS, replay, and errors.** Wrap both recovery operations so every `DeliveryStoreBusyError` becomes the established
structured retryable busy refusal. After any post-proof state change or final `DeliveryVersionConflictError`, first
replay the same operation id and full intent; an exact same-operation contender returns the immutable result without
rerunning fence, inspection, approval, or id allocation. Otherwise read and classify the actual winner: in-flight
states are retryable occupied, abandoned is terminal, quarantined returns its durable non-retryable evidence, and an
impossible state is non-retryable invalid. No raw version/busy error may escape. Approval, fence, and inspection
throws/malformed results become structured non-retryable quarantine refusals while leaving the original record
byte-for-byte unchanged; unexpected persistence failures retain their real causal chain and are never reported as a
safe recovery.

**Exact boundary and policy-first locking.** The frozen snapshot and every revalidation compare the exact lease and
the exact pre-recovery open tail, both before inspection and inside the store mutation. A store-legal concurrent tail
closure or append with an unchanged quarantine lease must refuse without another close, segment, or event. Under the
Delivery lock, read the record and authorize from canonical `createdBy` plus configured recovery principals before
calling `canonicalWorktreeFor` or acquiring any worktree lock. Only then resolve/compare the actual canonical path,
lock it in Delivery→worktree order, and re-read/revalidate authority/state/snapshot. Unauthorized holder, segment
principal, execution identity, peer, legacy, and external callers cause zero canonical-resolution, worktree-lock,
fence, inspection, approval, nonce, or mutation calls; original creator and configured principal remain allowed.

**Canonical inventory.** Replace `localeCompare` with a locale/ICU-independent total code-unit ordering for path and
status. Retain duplicate/malformed rejection and prove inventories containing locale-sensitive strings normalize and
hash identically regardless of host collation.

**Deterministic matrix.** Add forcing regressions for: configured-principal allow; every unauthorized identity/kind
with zero effects; fence outside both locks; unsupported/throwing/unknown/survivor/holder-less fence boundaries;
canonical path, lease, legal tail, HEAD, dirty path, unique commit, first-vs-second inspection, malformed/duplicate
inventory, and owns widening with byte-identical quarantine; salvage's single pending recovery segment plus dirty
evidence and no verified/accepted/clean/completed claim; approval decision, requester, digest, payloadHash,
resolvedAt, unbound, throw, and different-loss refusal; same-operation replay skipping all effects for both actions;
same-action and salvage-vs-abandon races using two DeliveryStore instances and barriers, with exactly one event/
segment winner and exact replay or actual-winner classification; abandoned validation/nonretryability/wait; and the
absence of any destructive dependency/action. Tests must force the intended interleaving, not merely assert a final
state.

Correction gates are the serial focused lease/store/verification suites, `npm run typecheck`, and
`git diff --check`. Do **not** run full verification during correction: the first candidate full is already green;
the next full is reserved for final closure after independent R2 acceptance. Commit exactly the seven owned paths by
pathspec with `t-0b5723`, then notify the coordinator with SHA, exact counts, and residual risk.

# T12 explicit quarantine recovery closure — 2026-07-12

- Added policy-first salvage/abandon recovery over the canonical Delivery. Authorization reads only the
  Bridge-resolved actor, original canonical creator, and trusted configured recovery principals; holder,
  execution-agent, segment-principal, and requested display identities grant no authority.
- Both actions require an exact `ProcessFencePort.proven_empty` boundary outside Delivery/worktree locks plus two
  stable, canonical loss-inventory inspections. Salvage preserves every byte and commit, closes the interrupted
  predecessor, and creates one pending recovery segment without claiming verification. Abandon requires an exact
  host-resolved approval digest and records a terminal `abandoned` state without deleting Git or filesystem data.
- Store validation, lease acquisition, repeat recovery, system verification, and bounded wait now agree on terminal
  abandoned semantics. Recovery receipts replay exactly; cross-store same/different-operation and salvage/abandon
  races return the durable receipt or classify the real winner without leaking SQLite busy/version errors.
- Coordinator A1-A3 and Sonnet R1 found and closed terminal retryability, raw CAS/busy failures, exact tail snapshot,
  authority ordering, locale-stable inventory, approval binding, and the complete forcing matrix. Final Sonnet R2
  verdict: **ACCEPT** (`9ca9a47`) over implementation/test head `b56b4ceb`.
- R2's one LOW, non-blocking test gap is tracked on the board as `t-cd8cbe`: isolate tail-only drift specifically in
  the fence-proof→`recoveryCurrent` window. Production is already protected by the exact snapshot plus store CAS.
- Final coordinator closure gates on `9ca9a47`: focused lease/store/verification 162/162, `npm run typecheck`, and
  `git diff --check` passed; `npm run verify:full:quiet` passed 301 files with 3,603 tests passed and 3 skipped.
  Progress is now design T0/T0.1/T0.2 plus T1–T12 = 15/23 primary checklist items complete; T13 bound persistent
  executions is next.

### T13 implementation contract — declared-agent bound executions

T13 adds one explicit declared-definition binding mode to the existing `delivery_join` spawn path. It does not wire
the production `DeliveryLeaseService` into `Workspace` while the real `ProcessFencePort` remains unavailable, persist
Delivery bindings for reload (T14), change configured lifecycle authority, add GitDelivery projection behavior, or
permit a same-Delivery fallback worktree. The current ad-hoc `cmd` join and ordinary declared-agent spawn remain
compatible.

**Measured boundary and API.** `spawn_agent` currently treats `name` as the runtime/Bridge identity, while optional
`delivery_join.principal` is attribution only; `AgentManager.spawnCore` resolves a definition by that runtime name,
mints the per-agent Bridge token with that name, materializes private runtime state under that name, and writes the
session ledger under that name. A unique execution name therefore cannot reuse a differently named declared
definition today. Add optional `delivery_join.declared_agent` as the explicit selection field. It is mutually
exclusive with top-level `cmd` and with legacy attribution-only `delivery_join.principal`. `name` remains the
caller-supplied `executionAgent`; it must differ from `declared_agent` and must not collide with a configured
definition, an in-memory ad-hoc definition, an existing session-ledger row, or any live/dead tmux session. Reject all
of those before lease reservation. Do not reinterpret or remove the legacy `principal` field.

The selected source must exist in the current parsed config and have `kind: agent`; terminals, unknown names, and an
ad-hoc definition that merely shares the requested source name are refused. Snapshot the parsed `AgentDef` before
reservation and derive a new ephemeral definition: preserve runtime command, role, instructions, declared env,
harness/isolate configuration, watch, and attention behavior; append the Bridge-managed delegation contract after
the declared role instructions. Force `autostart: false`, `restart: never`, and discard declared worktree/branch/
setup/verify/subagent lifecycle settings because the Delivery already owns the worktree and the execution is not the
persistent home session. Reviewer safety transformation applies to the derived command before reservation.

Extend the private forced-spawn channel so `spawnCore` accepts the derived definition and an explicit ephemeral flag,
while still forcing the prepared Delivery cwd/worktree and bypassing every fresh-worktree resolver. Do not add the
derived definition to `tachyon.yml` or mutate the source object. The derived execution is recorded/listed/cleaned as
an ad-hoc agent under `name`; its ledger `declared` bit is false. T14, not T13, owns durable Delivery/segment binding
and reload reconstruction.

**Identity and authority invariants.** Normalize the request passed to `prepareDeliveryJoin`,
`confirmDeliveryJoin`, and `failDeliveryJoin` so `principal` is exactly `declared_agent`, while `executionAgent` is
always `name`. The Delivery service therefore persists both identities without granting policy authority to either;
Bridge-resolved `grantedBy` remains the authority boundary. Mint `TACHYON_AGENT_BRIDGE_TOKEN` only for the execution
name, set `TACHYON_AGENT_NAME` to the execution name, materialize MCP/session-ownership files and private runtime home
only under the execution name, and never read, mint, revoke, overwrite, stop, resume, or clean the principal's live
session. The source definition's env may not override either reserved identity variable in the bound execution;
refuse a declared source that explicitly supplies `TACHYON_AGENT_BRIDGE_TOKEN` rather than risking token
impersonation. Existing shared-token compatibility is unchanged and is not treated as principal identity.

Because every hook, activity, ledger, harness, token, and continuity lookup keys on execution name, the bound child
must receive the normal ad-hoc/ownership-only prompt hooks and completion doorbell addressed from its execution
identity. Its source principal's ledger row, cwd, resume binding/config home, caller-token registry entry, harness
tree, activity owner rows, and `.tachyon/continuity/<principal>.md` and state file remain byte-for-byte untouched.
Cleanup or confirmation compensation targets only the execution name. If cleanup or reservation compensation fails,
preserve the existing aggregate causal error and never fall back to stopping the principal.

**Bridge contract and compatibility.** A `delivery_join.declared_agent` spawn is an AI delegation even though it
omits `cmd`; require the same structured `task`/`context`/`constraints` plus `deliverable` or `done_when` contract as
an ad-hoc AI child, and deliver the identity line using the execution name. `skip_contract_reason` remains forbidden
with a gated contract but otherwise retains its existing semantics; no new authority is inferred from config
ownership metadata. Preserve byte-for-byte behavior for ordinary `spawn_agent(name)` declared starts, ad-hoc joins
with `cmd`, and legacy joins carrying attribution-only `principal`.

**Failure order.** Before `prepareDeliveryJoin`, validate field exclusivity, source kind/existence, unique execution
name, reserved env, reviewer command structure, and runtime launch preflight for the effective derived command. No
invalid binding may create a reservation, tmux session, token, ledger row, harness home, or contract brief file. Once
reserved, retain the existing spawn/confirm compensation protocol: a spawn or confirmation failure stops and cleans
only the bound execution, then consumes/quarantines the exact reservation; aggregate every primary and cleanup error
in stable causal order.

**Owned implementation paths.** `src/agents/AgentManager.ts`, `src/bridge/tools.ts`,
`test/unit/agentManager.test.ts`, `test/unit/bridge.test.ts`, and the exact Bridge-generated canonical behavior stub
`test/unit/deliveryBoundT13TerraBehavior.gen.test.ts` only. The stub must replace its placeholder failure with a
truthful assertion over the implemented behavior; it may not be renamed, removed, skipped, or weakened. No Workspace, Delivery store/service/type,
SessionLedger schema, config/schema, GitDelivery, continuity implementation, tachyon.yml, or task-store edit. If the
current interfaces cannot prove principal token/home/continuity non-mutation within these paths, stop and return the
missing seam instead of widening scope.

**Deterministic test matrix.** Keep a declared principal live, snapshot its ledger row/cwd/resume/config home,
token-mint calls, harness materialization calls, continuity files, and tmux command/env; then bind a reviewer through
a different execution name and prove both sessions remain live, the Delivery callbacks receive
`executionAgent=name` plus `principal=declared_agent`, the reviewer-safe command and declared role/contract run in the
prepared Delivery cwd, only the execution token/home/ledger/activity hooks are created, and the principal snapshot is
unchanged before and after bound cleanup. Prove harness/isolate/env inheritance under the execution name; ad-hoc
classification and `declared:false`; no fresh-worktree resolver; structured contract enforcement without top-level
`cmd`; unknown/terminal source, same/colliding execution name across config/ad-hoc/ledger/tmux, reserved token env,
`cmd+declared_agent`, `principal+declared_agent`, unsafe reviewer command, and failed launch preflight all refuse with
zero reservation/runtime/identity effects. Force confirmation plus cleanup failures and prove only the execution is
targeted. Retain existing T6/T10 ad-hoc join and ordinary declared-spawn tests unchanged.

**Runtime/model and done condition.** Use the declared `codex-executor` at `gpt-5.6-terra` medium: the design is
closed, the production/test change is four paths plus the mechanically generated behavior stub, and the remaining work is bounded implementation with identity-sensitive failure
ordering but no unresolved architecture. The behavior gate is `a persistent identity reviews through a bound
execution without rebinding or impersonation`. Run the focused AgentManager and Bridge suites serially,
`npm run typecheck`, `git diff --check`, then `npm run verify:full:quiet` exactly once at the first reviewable
candidate. Commit only the five owned paths with `t-0b5723` and notify `codex`; immutable Sonnet review and final
closure verification remain coordinator gates.

### T13 R1 independent review contract

Review immutable range `221b3d9..672ba2e0` against the T13 implementation contract above (including the generated
stub correction at `7986b65a`). The candidate changes exactly the five owned paths and self-reports focused
AgentManager 269, Bridge 57, generated behavior 1, typecheck, diff-check, and quiet full verification green (302
files, 3,605 passed, 3 skipped). Coordinator `verify_task` is nevertheless **BLOCKED** at record
`.tachyon/verifications/672ba2e02140c8717c0181f59fa7ea00821c36c9.json`: the immutable behavior command exits zero
at BASE when its `-t` pattern matches no test, so it cannot prove fail-before/pass-after. The generated stub was
changed from the required placeholder failure to an unconnected `expect(true)`.

Audit the entire delta and surrounding spawn, readiness, token registry, harness/home, ledger, continuity/activity,
reviewer-command, Bridge contract, Delivery reservation/confirmation/failure, and cleanup call paths. Coordinator
hypotheses are starting points, not the limit of review:

- the one happy-path test does not implement the contract's deterministic rejection/isolation/compensation matrix,
  and Bridge has no successful bound-execution mapping proof;
- `spawned` becomes true only after `spawnCore` returns, but token/home/settings/session side effects occur inside
  `spawnCore`; `newSession` or Codex readiness failure can therefore leave a live execution token/private footprint
  after the session is absent while the outer catch runs only reservation compensation;
- declared harness is retained by shallow reference rather than an immutable definition snapshot, and the effective
  launch preflight runs twice (before and after reservation); inspect whether either can violate the bound snapshot,
  side-effect order, or exact failure causality;
- prove/refute all config/ad-hoc/ledger/tmux name collisions, unknown/terminal/same-name source, reserved token env,
  principal/cmd conflicts, unsafe reviewer command, failed preflight, harness/isolate/env inheritance, execution-only
  mint/materialization/hooks/cleanup, principal ledger/cwd/home/token/continuity immutability, and combined spawn/
  confirmation/reservation cleanup errors.

Return every severity-ranked production and test-truthfulness finding in one artifact
`.tachyon/reviews/368-delivery-bound-t13-r1.md`. Stay read-only for production/tests and do not design or implement
fixes. Allowed gates: serial focused AgentManager, Bridge, and generated behavior suites plus `git diff --check`;
do not rerun typecheck or full verification. Commit only the review artifact by explicit pathspec with `t-0b5723`,
then notify `codex` with one-line ACCEPT or FINDINGS and the SHA/pointer.

### T13 R1 consolidated correction contract

Candidate `672ba2e0` is rejected. Coordinator audit plus Sonnet R1 `9344877`
(`.tachyon/reviews/368-delivery-bound-t13-r1.md`) confirm one non-forcing gate, one security-relevant partial-spawn
cleanup defect, a largely absent deterministic matrix, and a defensive snapshot gap. The old delegation
`8eb4de50-3c18-494b-975b-84874a0b36b4` can never be accepted because its immutable `cmd:` behavior verifier exits
zero at BASE when no test matches; do not waive or reuse it. Start a fresh gated Delivery from current main.

**Runtime/model and authority.** Use Terra medium: production changes are bounded, but exact teardown/liveness/error
causality and deterministic failure scheduling require more than Luna. The coordinator owns every choice below.
Own only `src/agents/AgentManager.ts`, `src/bridge/tools.ts`, `test/unit/agentManager.test.ts`,
`test/unit/bridge.test.ts`, one new focused helper `test/helpers/boundDeliveryExecutionHarness.ts`, and the exact
Bridge-generated stub `test/unit/deliveryBoundT13FixR2Behavior.gen.test.ts`. No Workspace, config/schema,
SessionLedger schema, Delivery service/store/types, GitDelivery, continuity implementation, tachyon.yml, docs, task
state, or other test edit.

**Forcing behavior gate.** The new immutable behavior test is the ordinary Vitest pattern
`a bound Delivery execution preserves its declared principal and cleans every partial spawn failure` — never a
`cmd:` verifier. Tachyon's generated BASE stub must match that title and retain `expect.fail`, so fail-before is
mechanically forced. At HEAD the same stub imports and awaits the focused helper, which must instantiate the real
`AgentManager`/`TmuxService`, exercise a live declared principal plus a distinct bound execution, force at least one
post-mint/pre-return spawn failure, and assert identity isolation plus cleanup. A constant/static/source-text
assertion, nested Vitest invocation, skip, rename, or deletion is forbidden. The main AgentManager suite may reuse
the helper, but the generated stub itself must fail if the production behavior is reverted.

**Immutable declared-definition snapshot.** Preserve the accepted field policy from `672ba2e0`, but clone every
mutable nested value used by the execution. `watch`, `attention.patterns`, `env`, and the complete nested `harness`
graph must not share references with the current config object; `isolate`, command, role, and instruction strings are
primitives. A deterministic barrier test mutates the source config's nested harness/env/attention values after
`prepareDeliveryJoin` begins and proves the execution materializes the pre-reservation snapshot. Keep lifecycle
fields stripped (`autostart:false`, `restart:never`, no source worktree/branch/setup/verify/subagents).

**One preflight before reservation.** Reviewer-safe command construction and runtime launch preflight occur exactly
once before `prepareDeliveryJoin`. Extend the private forced-spawn channel with an explicit proof that this effective
command/env was already preflighted, so `spawnCore` does not repeat the catalog call after reservation. The proof is
private to this synchronous call and cannot be supplied by Bridge/user input. Failed preflight has zero reservation,
token, home/MCP/settings, tmux, ledger, activity, or principal effects.

**Partial-spawn cleanup algorithm.** Replace the `spawned`-after-return guard for both bound and existing ad-hoc
Delivery joins with one exact execution-cleanup path after any error occurring after reservation (spawn failure,
readiness rejection, or confirmation failure):

1. Preserve the primary error. Probe the execution tmux session. If present, attempt `killSession`, then re-probe;
   an absent session is proven gone, while probe/kill/re-probe error or continued presence is unknown/live.
2. Revoke the execution-name Bridge token unconditionally and exactly once; never mint/revoke the principal token.
   Token revocation failure is retained as a cleanup error, not allowed to skip later compensation.
3. Only after session absence is proven, clear execution-only in-memory ad-hoc/lineage/delegator/readiness state,
   remove the execution ledger/activity/session-owner/harness-home/spawn-settings footprint idempotently, and emit
   the normal killed/view callback. Never remove or rewrite the principal's cwd, resume/config home, token, harness,
   activity ownership, continuity brief/state, or live tmux session.
4. If absence is not proven, retain the execution's durable/private footprint for recovery and append an explicit
   cleanup error that the runtime may still be live; do not report safe cleanup or delete its home. The token remains
   revoked so an orphan cannot exercise Bridge authority.
5. Regardless of execution-cleanup outcome, call `failDeliveryJoin` once with the exact normalized request,
   reservation, and primary error. Aggregate in stable order: primary → session/liveness/footprint/token cleanup
   errors → reservation-compensation error. Exact successful cleanup rethrows only the primary.

The helper may be private to `AgentManager`; do not add a Workspace policy or another lifecycle state machine.
Cleanup must cover failures before `spawnCore` writes `adhoc`/ledger, after tmux creation/readiness rejection, and
after full spawn during confirmation. Preserve accepted T6/T10 behavior while closing their shared spawned-flag gap.

**Complete deterministic matrix.** Implement every named case, with counters/barriers that fail if effects happen in
the wrong phase:

1. Bridge success without top-level `cmd`: structured contract is appended after declared role/instructions and the
   manager receives execution name plus `declaredAgent`; missing contract still refuses.
2. Live principal happy path: both sessions stay live; callbacks receive `executionAgent=name` and
   `principal=declared_agent`; reviewer-safe command, declared env/harness/isolate, prepared Delivery cwd/worktree,
   execution token/private home/ownership-only hooks, ad-hoc listing, and `declared:false` ledger are exact; fresh
   worktree resolution is never called. Snapshot principal ledger/cwd/resume/config home, token registry, harness,
   activity owner rows, continuity brief/state, tmux command/env, and prove them unchanged before/after execution
   cleanup.
3. Table-driven pre-reservation refusals: unknown and terminal source; same name; collision in config, ad-hoc map,
   ledger, live tmux, and dead/postmortem tmux; reserved token env; `cmd+declared_agent`;
   `principal+declared_agent`; unsafe reviewer command; and failed launch preflight. Each asserts zero
   `prepareDeliveryJoin`, token mint, harness/MCP/settings, new-session/kill, ledger/activity, and principal effects.
4. Defensive snapshot barrier described above plus a one-call preflight assertion.
5. Force `tmux.newSession` failure after token/home materialization, Codex readiness rejection after session
   creation, and confirmation failure after full spawn. When absence is provable, assert session gone, execution
   token revoked, execution footprint removed, reservation failed once, and principal byte-for-byte untouched.
6. Force initial liveness probe error, kill error, post-kill probe error/session survivor, token-revoke error,
   footprint-removal error, and reservation-compensation error independently and in meaningful combinations.
   Assert no later cleanup step is skipped, unknown/live keeps durable footprint, token revocation is attempted,
   errors retain exact stable causal order, and no principal action occurs.
7. Retain all existing T6/T10 ad-hoc join and ordinary declared-spawn behavior. Generated-stub helper plus focused
   suites must be truthful and leak no temp session/home/files on success or failure.

**Gates and done condition.** Run the generated stub, AgentManager, and Bridge suites serially, then
`npm run typecheck` and `git diff --check`. Do not run full verification in this correction: the rejected first
candidate already consumed the first-reviewable full gate; the next full is reserved for final closure after R2.
Commit exactly the six owned paths by explicit pathspec with `t-0b5723`; notify `codex` with SHA, exact counts, and
residual risk. Coordinator must run `verify_task` with no waivers and receive ACCEPT before immutable Sonnet R2.

### T13 coordinator A1 completion contract

Correction candidate `b160cabd` has a valid canonical gate: `verify_task` ACCEPT at
`.tachyon/verifications/b160cabd24c4b98fcad6adc1a2233e694bd6618d.json` proves one matching BASE failure and one
HEAD pass with no waiver. It is still semantically withheld. The executor implemented only a real readiness-failure
helper, one snapshot/happy-path test, three aggregated collision cases, and two Bridge refusals; it did not deliver
the seven-block deterministic matrix. Its cleanup also groups `forgetAdhoc`, `removeEphemeralFootprint`, and
`onKilled` in one `try`, does not clear all execution readiness state, and the canonical `forgetAgent()` itself can
skip later footprint removals when an earlier dependency throws. Because the prior Delivery does not own
`src/agents/forgetAgent.ts`, do not widen/reuse it. Start one fresh gated Delivery and cherry-pick/reimplement
`b160cabd` under the exact authority below.

**Owned paths and model.** Terra medium; exact paths are `src/agents/AgentManager.ts`,
`src/agents/forgetAgent.ts`, `src/bridge/tools.ts`, `test/unit/agentManager.test.ts`, `test/unit/bridge.test.ts`,
`test/helpers/boundDeliveryExecutionHarness.ts`, and the new generated behavior stub only. No other production,
test, docs, config, Workspace, Delivery, ledger-schema, GitDelivery, continuity, tachyon.yml, or task-state edit.

**Canonical footprint cleanup.** Make `forgetAgent()` attempt each named footprint independently in stable order:
ledger row; activity log/writer state; session-owner rows; private harness/config home; per-spawn settings. Collect
every thrown error and, only after all attempts, throw one AggregateError preserving the ordered causes. Missing
artifacts remain idempotent success. Update its existing AgentManager-suite tests to force failures in early and
middle dependencies and prove every later removal still runs exactly once; retain the authoritative footprint list.

**Delivery execution cleanup.** After session absence is proven, perform each action independently so one failure
cannot skip the next: clear `readyAgents`, `provisionalAgents`, `readinessCache`, `stoppingSince`, `stopFailed`,
`cleanExited`, and `postmortemOutput`; forget ad-hoc/lineage/delegator state; call the now-aggregate canonical
footprint cleanup; emit `onKilled`. Preserve each error with an exact phase label. If absence is unknown/live, clear
none of the recoverable footprint/session state and emit no killed callback. Token revocation remains unconditional
and execution-only. Final error order is primary → session probe/kill/re-probe → token revoke → in-memory cleanup →
footprint AggregateError → killed callback → reservation compensation. Later phases always run when their safety
precondition holds. Exact successful cleanup rethrows only the primary.

**Required proof matrix — no sampling.** Keep the forcing generated helper and add all missing cases from the R1
contract, each with explicit effect counters/snapshots:

1. Bridge **success** without `cmd` proves the full structured contract becomes `appendInstructions`, manager input
   retains execution `name`/`declaredAgent`, and parent remains Bridge-resolved; keep both refusal cases.
2. Happy path uses a declared harness/isolate/env and real materializer seam. Assert execution-only config home,
   token, ownership hook, tmux env/command, prepared cwd/worktree, ad-hoc listing, ledger, and zero fresh-worktree
   resolution. Persist real principal continuity brief/state, activity owner data, harness marker, ledger/resume/home,
   token, and tmux snapshot and prove byte identity before and after execution cleanup.
3. Individually named pre-reservation cases: unknown source, terminal source, same name, config collision, ad-hoc
   collision, ledger collision, live tmux collision, dead/postmortem tmux collision, reserved token env,
   `cmd+declared_agent`, `principal+declared_agent`, unsafe reviewer command, and failed preflight. Each proves zero
   reservation, mint/revoke, harness/MCP/settings, tmux create/kill, ledger/activity, callback, and principal effects.
4. Snapshot barrier mutates nested harness MCP/env/hooks/rules/skills plus env/watch/attention after reservation begins
   and asserts the execution used the complete pre-reservation clone. Assert one and only one bound preflight.
5. Force `newSession` failure after token/home/settings materialization, readiness rejection after session creation,
   and confirmation failure after full spawn. Proven absence removes every execution footprint/state, revokes token,
   fails the reservation once, and leaves principal bytes/process/token untouched.
6. Independently force initial probe error, kill error with survivor, post-kill probe error, token-revoke error,
   early and middle canonical-footprint errors, killed-callback error, and reservation-compensation error; include
   meaningful combinations. Assert the exact stable AggregateError order, later safe cleanup attempts, footprint
   retention under unknown/live liveness, and no principal action.
7. The generated behavior stub must import/await the real helper. Extend that helper beyond readiness rejection to
   assert real execution home materialization/removal and principal home preservation. It must clean every temp
   directory/session in `finally`. Retain all T6/T10 and ordinary declared-spawn tests.

**Gates.** The new ordinary Vitest behavior pattern is
`a bound Delivery execution proves zero-effect refusals and complete failure cleanup`; BASE must execute exactly one
matching failing stub and HEAD exactly one passing real helper. Run generated stub, AgentManager, and Bridge suites
serially, `npm run typecheck`, and `git diff --check`; no full verification until final R2 acceptance. Commit exactly
the seven owned paths by explicit pathspec with `t-0b5723`, doorbell `codex`, then stop. Coordinator requires
`verify_task` ACCEPT and full content audit before immutable Sonnet R2.

### T13 R2 independent review contract

Review immutable range `0a4e1136..be23bd26` against the original T13 contract, R1 consolidated correction, and A1
completion contract above. The canonical gate ACCEPTED with no waiver at
`.tachyon/verifications/be23bd26c8bfec86a45410d05d02fa6a87319af5.json`; the executor also reports focused,
typecheck, diff-check, and quiet full verification green. These mechanical results do not establish semantic
acceptance.

Coordinator audit finds an immediate contract-coverage discrepancy: despite A1's explicit seven-block matrix with
"no sampling", the candidate changes only five lines in `test/unit/agentManager.test.ts`, twelve lines in
`test/unit/bridge.test.ts`, and adds a 58-line helper covering one happy path plus one readiness rejection. The
helper does not exercise pre-reservation refusal cases, the snapshot mutation barrier, `newSession` failure,
confirmation failure, liveness/cleanup dependency failures, normal execution cleanup, or the required exact
AggregateError ordering. Its behavior title claims zero-effect refusals and complete failure cleanup without
executing those classes. Treat this as a starting hypothesis and independently enumerate every required matrix
case against actual assertions.

Audit the full production delta and surrounding paths, especially: defensive cloning and stripped definition
fields; one-call preflight proof and reservation ordering; execution/principal provenance; reviewer-safe command;
token/home/settings/ownership/ledger/activity/continuity isolation; cleanup when session absence is proven versus
unknown/live; independent cleanup attempts and stable causal error ordering; ordinary declared/ad-hoc T6/T10
compatibility; and Bridge success mapping without top-level `cmd`. Check whether any cleanup action can target or
mutate the persistent principal. Do not design or implement fixes.

Write severity-ranked findings with file/line and contract evidence to
`.tachyon/reviews/368-delivery-bound-t13-r2.md`. Allowed verification is the three focused suites plus
`git diff --check`; do not rerun typecheck or full verification. Commit only the review artifact by explicit
pathspec with `t-0b5723`, then notify `codex` with one-line ACCEPT or FINDINGS and the SHA/pointer.

### T13 R2 consolidated correction contract — two sequential occupations, one acceptance boundary

Candidate `be23bd26` is rejected. Sonnet R2 `c51bc10c`
(`.tachyon/reviews/368-delivery-bound-t13-r2.md`) confirms two HIGH findings: the new unconditional failure cleanup
can erase a persistent declared agent's ledger/private home, and the A1 seven-block proof matrix remains largely
absent for a third round. Coordinator tracing broadens the first finding: cleanup currently runs even when
`spawnCore` rejected before acquiring the requested name, so a colliding live/dead session or pre-existing durable
row can be killed or forgotten despite belonging to another launch. A boolean based only on `bound`/`opts.cmd` is
not sufficient authority to clean.

This correction is one closed contract delivered through **two sequential occupations of the same fresh gated
worktree**, not two independent designs or acceptance points. Terra medium remains the implementation model: the
production change is bounded but lifecycle ownership, liveness uncertainty, and causal errors exclude Luna. The
first occupant owns the production safety correction and its forcing regression; after coordinator content audit,
the second occupant receives the same branch with test-only authority and completes the exhaustive matrix. Neither
phase is accepted or integrated alone. Final Sonnet review and full verification cover the combined immutable
range.

**Shared scope.** Start from current `main`, selectively carry forward the accepted parts of `be23bd26`, and own
only `src/agents/AgentManager.ts`, `src/agents/forgetAgent.ts`, `src/bridge/tools.ts`,
`test/unit/agentManager.test.ts`, `test/unit/bridge.test.ts`,
`test/helpers/boundDeliveryExecutionHarness.ts`, the prior generated R3 stub (delete it), and the new generated R4
stub. No Workspace, Delivery store/service/types, config/schema, SessionLedger schema, GitDelivery, continuity
implementation, tachyon.yml, docs, task state, or unrelated test edit. Preserve the structured clone, bound
identity mapping, Bridge contract, hardened `forgetAgent`, and forcing-helper approach where correct.

#### Occupation A — launch ownership and non-destructive compensation

Replace unconditional name-based cleanup authority with an explicit per-call launch-attempt receipt/state passed
through `spawnDeliveryJoin` and `spawnCore`. It must distinguish at minimum: validation/collision rejection before
name acquisition; a fresh ephemeral execution whose name/footprint this call owns; and an ordinary declared join
whose persistent definition/ledger/home pre-existed and must survive. Record the exact side-effect milestones needed
for compensation (token/materialization, session creation, readiness/ledger/ad-hoc registration) instead of
inferring ownership from final tmux absence or from `bound`/`opts.cmd` alone.

Before acquisition, a failure may compensate its Delivery reservation but must not clear readiness state, kill a
session, revoke a token, remove a ledger/activity/owner/settings/home footprint, forget lineage, or emit `onKilled`
for a pre-existing name. A fresh bound execution keeps fail-closed collision semantics and never reaps a racing
live/dead occupant. After acquisition, partial-spawn cleanup may touch only milestones owned by this attempt. For a
fresh ephemeral execution, proven session absence permits the complete A1 cleanup. For an ordinary declared join,
confirmation failure may tear down the session/token created by that attempt as legacy behavior requires, but must
preserve the declared agent's ledger/resume/config home, activity, ownership, continuity, definition, and unrelated
pre-existing state. Unknown/live liveness preserves recoverable state and reports the failure; no destructive
cleanup is justified by absence that was not proven.

Keep stable causal order and phase labels: primary failure, owned session probe/kill/re-probe, owned token action,
in-memory cleanup, ephemeral footprint AggregateError, killed callback, reservation compensation. Later safe phases
still run after an earlier failure; unsafe phases do not. Do not weaken the independently-attempted canonical
`forgetAgent()` cleanup.

The R4 ordinary Vitest behavior gate is
`a failed Delivery join never cleans state the launch attempt did not acquire`. Its generated BASE stub must fail
exactly once. At HEAD it imports the real helper and empirically proves at least: (1) a pre-existing live-name
collision is not killed/revoked/forgotten; (2) a declared principal with persisted ledger/home survives forced
confirmation failure; and (3) a distinct bound execution that fails after token/home/session creation is fully
cleaned without changing the principal. The helper must use the real AgentManager/TmuxService and clean temp state
in `finally`.

Occupation A runs the generated behavior, AgentManager, and Bridge suites serially, `npm run typecheck`, and
`git diff --check`; no full verification. Commit all owned Phase-A paths by explicit pathspec with `t-0b5723`, ring
`codex`, and stop. Coordinator will run `verify_task` without waivers and audit the full production path before
granting Occupation B; ACCEPT at this intermediate gate is necessary but not T13 acceptance.

#### Occupation B — exhaustive proof, test-only

Reuse Occupation A's exact delegation/worktree/HEAD with authority limited to the two unit suites, focused helper,
and R4 generated stub. No production edit. Implement every A1 block that is not already proved, with individually
named cases and explicit counters/byte snapshots — no aggregation that hides a named case and no source-text/static
assertion:

1. Bridge success without top-level `cmd`, exact `appendInstructions`, execution name/`declaredAgent`, and resolved
   parent mapping, plus existing refusal cases.
2. Full live-principal happy path with harness/isolate/env, config home, token, ownership hook, tmux command/env,
   prepared cwd/worktree, ad-hoc listing, `declared:false`, zero fresh-worktree resolution, and byte-identity snapshots
   of principal ledger/resume/home, continuity/state, activity-owner data, token and tmux before/after cleanup.
3. Each pre-reservation refusal separately: unknown/terminal source, same name, config/ad-hoc/ledger/live-tmux/
   dead-tmux collision, reserved token env, `cmd+declared_agent`, `principal+declared_agent`, unsafe reviewer command,
   and failed preflight. Each proves zero reservation, mint/revoke, materialization/settings, session create/kill,
   ledger/activity/callback, and principal effects.
4. Nested snapshot-mutation barrier for harness MCP/env/hooks/rules/skills plus env/watch/attention, and exactly one
   bound preflight.
5. Independent `newSession`, readiness, and confirmation failures with exact owned cleanup and principal isolation.
6. Independent initial-probe, kill-with-survivor, post-kill-probe, token-revoke, early/middle canonical-footprint,
   killed-callback, and reservation-compensation failures plus meaningful combinations; exact AggregateError order,
   later-safe attempts, and footprint retention under unknown/live liveness.
7. The real forcing helper retains the three Occupation-A scenarios and truthful assertions; all T6/T10 and ordinary
   declared-spawn compatibility tests remain green.

Occupation B runs only the three serial focused suites and `git diff --check`, then commits its test-only delta by
explicit pathspec with `t-0b5723`, rings `codex`, and stops. Coordinator reruns the original R4 `verify_task` at the
combined HEAD, audits the entire matrix/delta, routes one immutable Sonnet R3 review, and only after ACCEPT runs the
single final `npm run verify:full:quiet`. No additional full run is authorized: `be23bd26` already consumed the
first-reviewable full gate.

### T13 R4A coordinator audit — production correction A2 before Occupation B

R4A candidate `afd9db60` has a valid no-waiver canonical gate at
`.tachyon/verifications/afd9db60478191808d68864ee9444136219db0f8.json`, but Occupation B is not yet authorized.
Coordinator content audit found three receipt/cleanup violations in the new production path; combine them into one
A2 correction on the same worktree before any matrix-only work.

1. `attempt.acquired` is initialized true in `spawnDeliveryJoin` before `spawnCore` rechecks tmux/name state. The
   outer bound precheck is not atomic with spawn. If a live session appears during `prepareDeliveryJoin`, the inner
   collision throws but ephemeral cleanup still clears transient/ad-hoc state and emits `onKilled`; if a dead pane
   appears, legacy `spawnCore` kills it and proceeds. Both violate the contract that a fresh bound execution never
   reaps or cleans a racing occupant. Initialize unacquired. For a bound attempt, recheck config, ad-hoc map, ledger,
   and any live/dead tmux session at the inner acquisition boundary and refuse without reaping. Set acquired only
   after those checks and launch preflight succeed. Ordinary non-Delivery spawn/dead-pane behavior stays unchanged.

2. `attempt.token` and `attempt.materialized` are set before evaluating `getExtraEnv`, `mintAgentToken`,
   `effectiveCmd`, or `applyHarness`. A `getExtraEnv`/command-composition failure can therefore revoke a persistent
   declared token which this attempt never minted. Model milestones honestly (`not-started`/`attempted`/`completed`
   where a dependency can throw after partial effects). Evaluate extra env separately; mark token owned only after a
   successful mint result, and never revoke a declared principal token on an earlier failure. A fresh acquired
   ephemeral name may conservatively remove materialization after the materializer was invoked because no prior
   footprint can belong to another identity; do not label invocation as completed. If session creation returns an
   ambiguous failure, never kill an unproven racing session: preserve/reconcile with an explicit uncertainty error.

3. After a declared attempt creates and then compensates its own session, cleanup returns at
   `!attempt.ephemeral` before the killed callback. Preserve the declared durable ledger/home, but clear only
   transient state owned by the created session and emit `onKilled` exactly once after proven absence, matching the
   legacy lifecycle. No callback or transient clear is allowed for pre-acquisition collision/failure.

Add deterministic helper/AgentManager assertions for: a bound live and dead collision injected during preparation
(zero kill/revoke/forget/transient/callback effects); `getExtraEnv` failure before mint for a persisted declared
principal (zero revoke and byte-identical principal state); and declared confirmation compensation (owned session
gone, durable identity preserved, callback exactly once). Retain all existing R4 three-scenario assertions and the
forcing title unchanged.

Reuse delegation `84f9d521-e294-4bd9-8f48-66d6114a7297` at exact HEAD `afd9db60` with production/test authority
limited to its original owns. Terra medium remains required. Run R4 generated, AgentManager, and Bridge suites
serially, `npm run typecheck`, and `git diff --check`; no full. Commit the A2 delta by explicit pathspec with
`t-0b5723`, ring `codex`, and stop. Coordinator reruns the original `verify_task` and full content audit; only then
may Occupation B receive test-only authority.

### T13 R4A2 coordinator audit — final production correction A3 before Occupation B

A2 `60895afa` passes the original R4 gate without waiver at
`.tachyon/verifications/60895afa400ad27fbd41c6729f6cbab4cd5e2a0c.json` and closes its three assigned findings.
Occupation B remains blocked on two milestone/mode errors found in the combined production audit:

1. `cleanupFailedDeliveryExecution` treats `session:not-started` as proven absence, then clears all transient sets,
   calls `forgetAdhoc`, and emits `onKilled` for an ordinary declared join. A failure after acquisition but before
   `newSession` (for example materializer/Bridge composition failure) therefore mutates readiness/lineage/callback
   state which the attempt never created. For a declared attempt, revoke only a token actually minted; clear
   session-transient state and emit `onKilled` only when `session:completed` was subsequently proven absent. Never
   call `forgetAdhoc` or remove durable footprint for declared mode. `session:attempted` remains uncertainty and
   preserves state.

2. The receipt's `ephemeral` bit is currently `!!declared_agent`, excluding the accepted T6/T10 ad-hoc `cmd`
   Delivery join. That path therefore retains the original partial-spawn leak the R1/A1 contract explicitly required
   this shared cleanup to close. Replace the boolean with an explicit mode (or equivalent closed representation):
   bound ephemeral, cmd-ad-hoc ephemeral, ordinary declared persistent. Both ephemeral modes require a fresh inner
   identity check and own their newly materialized/token/session/ledger/ad-hoc footprint; both receive complete
   partial cleanup after proven absence. Declared mode preserves durable identity. Do not infer mode later from
   mutable maps.

Separate cleanup phases by what the receipt actually owns: token; session-transient state; ephemeral in-memory
definition/lineage; ephemeral durable footprint; callback. A fresh ephemeral attempt with no completed session may
still remove its own attempted materialization after absence is structurally known, but it must not pretend a
session was killed. A declared attempt with no completed session performs none of the session/ephemeral/callback
phases.

Add real regression assertions for: declared post-acquisition/pre-session materializer failure preserving callback,
readiness/lineage/durable principal state while revoking only its newly minted token; and ad-hoc `cmd` readiness
failure removing its token/home/session/ledger/ad-hoc listing with reservation compensation exactly once. Keep the
R4 forcing scenarios and all prior assertions. This A3 does not start the broad Occupation-B matrix.

Reuse the same delegation at exact `60895afa` with original production/test authority. Terra medium; focused R4,
AgentManager, Bridge, typecheck and diff-check only, no full. Commit by explicit pathspec with `t-0b5723`, ring
`codex`, and stop. Coordinator reruns the original gate/content audit; only a clean result unlocks B test-only.
