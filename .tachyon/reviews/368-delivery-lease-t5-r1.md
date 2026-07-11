# SDD 368 T5 adversarial review — `e4c66cf`

**Verdict: FINDINGS**

Scope: `src/agents/processFence.ts`, `src/delivery/leaseService.ts`, `test/unit/deliveryLeaseService.test.ts` as of
commit `e4c66cf0519620994611ffb4404dc40d208f9482`. Focus: cross-process races, lock order, live-HEAD TOCTOU,
operation-receipt retries, pending/held invariants, process identity, capability bypass, scope normalization, and
whether the test suite actually proves contention. No T6/T7/T11 feature (successor worktree reuse, fenced handoff,
crash reconciliation) is expected or demanded here; findings below are scoped to what T5 itself implements or
claims.

All findings were verified by reading `src/delivery/store.ts` (T1) alongside the diff, and the two most severe
findings were additionally reproduced by bundling the actual `leaseService.ts`/`store.ts` sources with esbuild and
driving them from standalone Node scripts against a real `node:sqlite` database (commands under "Commands used").

## F1 — HIGH — a lost `acquire()` response cannot be safely retried; the winner is told it lost to itself

Evidence: `src/delivery/leaseService.ts:97` (`this.assertAcquirable(current)`) runs *before* `store.update` is ever
reached, on a plain `store.get()` snapshot. `DeliveryLeaseAcquireInput.operationId` (`leaseService.ts:36`) is
threaded into `store.update`'s durable receipt table (`leaseService.ts:156-159`) specifically so, per
`plan.md`, "a post-commit response loss cannot duplicate work." But a caller that never saw the first response
and retries `acquire()` with the *same* `operationId`/args does not reach the receipt-replay code at all: the
second call's `store.get()` now observes `lease.state: "pending"` (the caller's own successful reservation), so
`assertAcquirable` throws `WORKTREE_OCCUPIED` at `leaseService.ts:201` immediately — reporting the caller's own
`executionAgent` back to it as the "occupant" (`occupied()`, `leaseService.ts:204-210`). The caller cannot
distinguish "you already won, here is your reservation" from "someone else has it"; the only artifact that would
disambiguate this (the `reservationNonce`) was in the response that got lost. `store.ts`'s
`DeliveryVersionConflictError`-driven replay path (`store.ts:239-243`) is therefore dead code for this call shape:
by the time `acquire()` would reach it, the version has already moved and the pre-check above always intercepts
first.

Reproduced empirically (`probe.cjs`): first `acquire()` with `operationId: "acquire-op-1"` succeeds
(`lease.state: "pending"`); the identical retry throws
`WORKTREE_OCCUPIED: Delivery already has an occupant or reservation {"occupant":"fixer-a"}` — `fixer-a` being the
retrying caller itself.

Required closure: `acquire()` must resolve operation-id replay *before* the state-based `assertAcquirable` guard —
e.g., check the receipt table for `input.operationId` first and return the cached reservation/result when the
fingerprint matches, only falling through to the free/occupied checks on a genuinely new operation id. Add a unit
test that retries `acquire()` with the same `operationId` after a successful commit and asserts the *original*
reservation is returned, not `WORKTREE_OCCUPIED`.

## F2 — HIGH — `confirmHeld()` has the identical unsafe-retry defect

Evidence: `leaseService.ts:176` (`this.occupied(current, "reservation is no longer pending for this nonce")`) gates
on `lease.state === "pending"` before any receipt lookup, exactly mirroring F1. After a successful `confirmHeld`,
state is `"held"`, so a retry with the same `operationId`/nonce (again simulating a lost response to the process
that just legitimately confirmed) throws `WORKTREE_OCCUPIED: reservation is no longer pending for this nonce`
instead of returning the already-held `Delivery`.

Reproduced empirically (`probe2.cjs`): first `confirmHeld` transitions to `held`; identical retry throws
`WORKTREE_OCCUPIED: reservation is no longer pending for this nonce {"state":"held","occupant":"fixer-a"}`.

Required closure: same as F1, applied to `confirmHeld` — resolve `operationId` replay ahead of the `pending`/nonce
state check.

## F3 — HIGH — genuine SQLite write contention (not just version races) escapes the `WORKTREE_OCCUPIED` contract, and no test exercises it

Evidence: `store.ts:291` opens each connection with `timeout: this.opts.busyTimeoutMs ?? 0` — a zero busy timeout
by default, so a `BEGIN IMMEDIATE` (`store.ts:369`) issued while another connection holds the write lock fails
immediately as `SQLITE_BUSY` → `DeliveryStoreBusyError` (`store.ts:315`, code `DELIVERY_STORE_BUSY`,
`retryable: true`). `leaseService.ts:161-167`'s `catch` block only special-cases `DeliveryVersionConflictError`;
`DeliveryStoreBusyError` is neither caught nor translated and propagates as a raw, non-`DeliveryLeaseError` object.
A caller written against the documented `DeliveryLeaseErrorCode` union (`leaseService.ts:19-25`, which does not
include `DELIVERY_STORE_BUSY`) or checking `error instanceof DeliveryLeaseError`/`error.code === "WORKTREE_OCCUPIED"`
per the T5 gate wording will not treat this as the promised structured, retryable occupancy refusal.

This is the realistic shape of true cross-process contention: two independent OS processes racing to `BEGIN
IMMEDIATE` at the same instant collide at the SQLite lock, not at the application-level version check. The
existing `deliveryLeaseService.test.ts` "concurrent acquire" test (lines 33-49) cannot exercise this path at all —
it runs both acquisitions in one Node process, and `node:sqlite`'s `DatabaseSync` calls are synchronous, so the two
logical acquisitions can only interleave at `await` boundaries between fully-serialized synchronous SQL calls; two
`BEGIN IMMEDIATE`s can never literally collide within one process. The test therefore proves only the
version-staleness flavor of contention (already covered by `store.ts`'s own `DeliveryVersionConflictError` test),
not the busy-lock flavor that a second real process is far more likely to hit, and that flavor is demonstrably
mishandled.

Reproduced empirically (`probe3.cjs`): holding a raw `BEGIN IMMEDIATE` on a second `DatabaseSync` connection to the
same database file, then calling `lease.acquire(...)`, raises `DeliveryStoreBusyError` (`code:
"DELIVERY_STORE_BUSY"`), confirmed `instanceof DeliveryLeaseError` is `false`.

Required closure: catch `DeliveryStoreBusyError` (and any other `StructuredDeliveryStoreError`) in `acquire()`
(and `confirmHeld()`) alongside `DeliveryVersionConflictError`, and either retry internally within a bounded budget
or translate it into a structured `DeliveryLeaseError` so every caller sees one consistent contract for "someone
else currently has the write lock/version." Add a test that holds a real second SQLite connection's write
transaction open (as `deliveryStore.test.ts:105-118` already does at the store layer) while calling
`DeliveryLeaseService.acquire`, and assert the resulting error is a `DeliveryLeaseError` with a retryable code.

## F4 — MEDIUM — `confirmHeld` doesn't translate a genuine CAS race the way `acquire` does

Evidence: `acquire()` wraps its `store.update` call in a `try/catch` that turns `DeliveryVersionConflictError` into
`WORKTREE_OCCUPIED` (`leaseService.ts:126-167`). `confirmHeld()`'s call to `store.update`
(`leaseService.ts:180-196`) has no such wrapping. If two confirmation attempts for the same reservation race (e.g.
a client-side timeout fires a duplicate `confirmHeld` call while the first is still in flight, from a second
process/instance not sharing the in-process `withDeliveryLock`), the loser's `store.update` can hit
`current.version !== expectedVersion` inside the transaction (`store.ts:254`) and throw a raw
`DeliveryVersionConflictError`, which propagates unstructured out of `confirmHeld` — inconsistent with `acquire`'s
handling of the identical race shape.

Required closure: give `confirmHeld` the same version-conflict → structured-error translation as `acquire`, and add
a concurrent-`confirmHeld` test analogous to the existing concurrent-`acquire` test.

## F5 — MEDIUM — live-HEAD TOCTOU is only closed by an in-process mutex; no test proves the cross-process case

Evidence: `readHead` is correctly called inside `withWorktreeLock` (`leaseService.ts:94-106`), matching the
declared lock order (delivery lock → worktree mutex → live Git read, per the class doc comment at
`leaseService.ts:69-73` and `plan.md`'s "Risks & unknowns"). However `withWorktreeLock` is an injected dependency;
the two existing concrete implementations in this codebase (`AgentManager.ts:390,882-891` and
`Workspace.ts:972,990` wiring into `worktrees.withAgentPathLock`) are process-local `Promise` chains keyed by a
map, not OS- or filesystem-level locks. Nothing in this diff (nor anything reachable from it) prevents a *second*
Tachyon host process, or an out-of-band `git commit`/`git reset` in the same worktree from a shell, from moving
HEAD between this method's `readHead()` call and the `store.update()` commit that pins `grantedHeadSha: liveHead`
(`leaseService.ts:106,137,148`). The window is narrow (no I/O between the read and the commit in the current code
path) but real, and is not exercised by any test — `deliveryLeaseService.test.ts`'s `readHead` fake is a constant
closure that cannot represent a HEAD that changes mid-acquisition.

This is not a T5 regression — the store's SQLite CAS was always scoped to the Delivery *record*, not to Git state,
and `plan.md` explicitly keeps "Spawn, Git, tests, and waits" outside the transaction — but it means the acceptance
criterion "handoff is atomic and head-pinned" is not yet actually provable cross-process for the one piece T5 does
implement (the HEAD-pin at acquisition time), only within a single extension-host process.

Required closure (or explicit written acceptance if this is a deliberate, documented single-host assumption for
now): confirm whether `withWorktreeLock`'s real-world wiring is expected to be cross-process safe before T6/T7 land
on top of this HEAD-pin, and if not, record that as a known gap rather than silently relying on it. At minimum, add
a test where `readHead` returns a different value on a second call to prove `acquire` cannot commit a stale
`grantedHeadSha` if HEAD moves between the read and the commit (it currently cannot detect this at all, since
`readHead` is only called once per acquisition).

## F6 — LOW — `normalizeOwns` accepts a bare `.` or empty string as a literal scope entry

Evidence: `leaseService.ts:227-232` normalizes `""` and `"."` to the literal string `"."` (neither is caught by the
`!entry` / `".."` / `"../"` / absolute-path checks), rather than rejecting an empty/self scope outright. This is
not currently exploitable: `isOwnsSubset` (`reuseWorktree.ts:53-60`) resolves `"."` to the fake-root itself, which
only matches an *original* contract `owns` entry that is itself `"."`/empty (i.e. a Delivery already scoped to the
whole repo) — so no narrower contract can be widened through this path today. It is nonetheless a missing
input-validation guard: a caller that means to request "no additional scope" by passing `""` silently gets a
scope-shaped literal `"."` recorded into the segment's `ownsSubset` and the CAS intent fingerprint, instead of a
rejection.

Required closure: reject an entry that normalizes to `"."` or empty, the same way `".."`/`"../"` are rejected.

## F7 — LOW — stale `reservationNonce` survives on a `held` lease holder

Evidence: `confirmHeld`'s `record.lease = { ...record.lease, state: "held", holder: { ...record.lease.holder,
process }, ... }` (`leaseService.ts:184-189`) spreads the prior `holder` object, so `reservationNonce` remains
present on a `held` lease's holder even though the reservation has been consumed. Harmless today because every
downstream check gates on `lease.state === "pending"` first, so the stale nonce can't be replayed while held, but
it's a confusing leftover for anything that later inspects/logs the holder record.

Required closure: clear `reservationNonce` (or omit it) once the lease transitions to `held`.

## F8 — LOW — one invariant violation is thrown as a raw `DeliveryInvariantError`, bypassing `DeliveryLeaseErrorCode`

Evidence: `leaseService.ts:113-115` throws `DeliveryInvariantError` directly ("a successor acquisition requires a
closed predecessor segment") rather than a `DeliveryLeaseError`. In practice this should be unreachable —
`assertAcquirable` (line 97) already refuses whenever `lease.state !== "free"`, and the store enforces that an open
tail segment implies a non-free lease — but if it ever were reachable (e.g. future code path that frees a lease
without closing its tail segment), a caller keyed only on `DeliveryLeaseErrorCode`/`DeliveryLeaseError` would see an
unrecognized error shape instead of a structured refusal.

Required closure: none blocking; consider wrapping in a `DeliveryLeaseError` (e.g. a dedicated
`DELIVERY_SEGMENT_INVARIANT` code) for defense in depth, or leave as an intentionally-loud invariant crash and note
that choice in a comment.

## Confirmed behavior

- The core CAS grant is sound for the version-staleness race: two logical acquisitions against the same
  `deliveryId`, issued from two independent `DeliveryLeaseService`/`DeliveryStore` instances sharing one SQLite
  file, produce exactly one committed `pending` reservation and one `WORKTREE_OCCUPIED{retryable:true}` — verified
  both by the shipped test and by re-running the same shape through the bundled sources.
- Lock order matches the declared global order (delivery lock → canonical worktree mutex → live Git read) for
  `acquire`; no path in this file acquires the worktree mutex before the delivery lock.
- `processFence.capability()` is checked first, before any store read or mutation, and correctly leaves the lease
  `free` when unsupported — the current-host `UnavailableProcessFence` therefore blocks every acquisition, matching
  the task constraint that this host must remain capability-unavailable.
- Scope widening (`DELIVERY_OWNS_WIDENING`), HEAD drift (`DELIVERY_HEAD_CHANGED`), non-linear ancestry
  (`DELIVERY_NON_LINEAR_HEAD`), and non-canonical worktree (`DELIVERY_WORKTREE_MISMATCH`) are each rejected without
  ever calling `store.update`, so none of them can leave a partial mutation.
- `ownsSubset` normalization correctly rejects `..`-escaping and absolute paths outright (`leaseService.ts:229`) and
  is compared against the contract's *original* immutable `owns`, matching the spec's "subset of the original
  authority" wording rather than the narrower predecessor grant.
- The append-only/immutable-contract enforcement at the store layer (`store.ts:502-533`) independently backstops
  `leaseService`'s own segment/lease bookkeeping; nothing in this diff writes outside that envelope.

## Gate assessment

The stated T5 gate — "concurrent acquire grants one Delivery lease and returns retryable WORKTREE_OCCUPIED to the
loser" — holds for the specific race shape the shipped test constructs (in-process, version-staleness), but not for
the operation-receipt retry path (F1/F2) or genuine SQLite lock contention (F3), both of which are more realistic
manifestations of the "two executions attempt to acquire concurrently" scenario the acceptance criteria describe,
and neither of which the test suite exercises. F1–F3 mean a legitimate retrying caller can be told it lost a race
it actually won, and a real concurrent-process collision can surface an error shape outside the documented
contract. This is not sufficient to accept T5 as closing its own gate.

## Commands used

```
npm ci
npx vitest run test/unit/deliveryLeaseService.test.ts   # 4/4 pass, unmodified
node bundle.mjs    # esbuild-bundles src/delivery/leaseService.ts -> leaseService.cjs (cjs, node22 target)
node bundle2.mjs   # esbuild-bundles src/delivery/store.ts -> store.cjs
node probe.cjs     # reproduces F1: retried acquire() with same operationId -> false WORKTREE_OCCUPIED
node probe2.cjs    # reproduces F2: retried confirmHeld() with same operationId -> false WORKTREE_OCCUPIED
node probe3.cjs    # reproduces F3: real BEGIN IMMEDIATE contention -> unwrapped DeliveryStoreBusyError
```

Bundling/probe scripts are scratch-only (outside the repo, under the session scratchpad); no product or test file
was modified. `npm run verify:full` was intentionally not run per this review's constraints.
