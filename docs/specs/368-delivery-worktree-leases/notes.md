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
