# SDD 368 mechanism-only already-gone-predecessor fix — Sonnet R1 independent review — ACCEPT

Reviewed immutable candidate `d96019e52be9963b0ad8c78550ba29ba1a557c24` (branch
`tachyon/mechanismGonePredecessorGrokR1`, worktree
`/home/goat/.cache/tachyon/worktrees/b349073a/mechanismGonePredecessorGrokR1`) against setup base
`29753ac220ce309638e2d0e38ddbd866c20b72a5` for task t-9d4605. This is an independent second read; production
and test files were kept read-only throughout (no edits committed to the candidate tree).

## Incident recap

Live dogfood on installed 0.55.94 quarantined an already-gone predecessor handoff. Root cause: the mechanism-only
branch of `DeliveryLeaseService.establishTransferAbsence` (`src/delivery/leaseService.ts`) unconditionally required
and invoked `exactExecutionStopper.stop()` *before* ever observing whether the predecessor process was still
alive. The real `exactExecutionStopper` wiring in `src/workspace/Workspace.ts` reads the live tmux pane PID
(`this.tmux.panePid(...)`) to cross-check identity before killing — which fails when the pane is already gone
after a clean exit. A clean, already-exited predecessor therefore always hit `DELIVERY_EXACT_STOP_REFUSED` and got
quarantined, even though its exit was legitimate absence evidence.

## Delta reviewed

`git diff 29753ac2..d96019e5` touches exactly 6 files, 245(+)/43(-):

- `src/delivery/leaseService.ts` — the only production change, confined to the mechanism-only branch of
  `establishTransferAbsence` (lines ~1377–1404). The process-fenced branch, all lock/replay/CAS machinery, the
  pre-existing `reconcileHolder` observe-first path, `types.ts`, `store.ts`, `reloadReconciliation.ts`, and every
  file under `src/agents/` are byte-identical between base and candidate (`git diff` on those paths is empty).
- `test/unit/mechanismGonePredecessorGrokR1Behavior.gen.test.ts` — the coordinator's declared canonical behavior
  gate, expanded from a 7-line `expect.fail` stub into a real regression test. In-scope.
- `test/unit/deliveryLeaseService.test.ts` — expanded unit coverage for the new pre/post-observe sequencing.
- `test/unit/workspaceHeadless.test.ts` — new end-to-end integration test through the real `Workspace` wiring.
- `test/unit/deliveryMechanismB2TerraR1Behavior.gen.test.ts`,
  `test/unit/deliveryMechanismLeaseTerraR1Behavior.gen.test.ts` — **out-of-scope generated test files**, audited
  below (H7).

## New production logic (verbatim semantics)

```
if (!holder.executionNonce || !validProcessIdentity(holder.process) || !this.deps.processObserver) throw ...
const preObservation = await this.deps.processObserver.observe(structuredClone(holder.process));
if (!validProcessObservation(preObservation)) throw ...
if (preObservation.state === "gone")    return "root_gone_best_effort";      // no stop call at all
if (preObservation.state === "unknown") throw ...                            // fail closed, no stop call
if (!this.deps.exactExecutionStopper)   throw ...                            // alive but can't stop → fail closed
await this.deps.exactExecutionStopper.stop({ ...structuredClone(holder.process)... });
const postObservation = await this.deps.processObserver.observe(structuredClone(holder.process));
if (!validProcessObservation(postObservation)) throw ...
if (postObservation.state !== "gone")   throw ...
return "root_gone_best_effort";
```

The process-fenced branch above it is untouched. The lock-boundary comment ("Runs outside all Delivery/worktree
locks after the durable held-to-draining CAS") is pre-existing and still accurate — no new concurrency window was
introduced; the same operations that ran unconditionally before now run conditionally, in the same place in the
control flow, between the same CAS transitions.

## Hypothesis-by-hypothesis verdict

- **H1 (persisted identity pre-gone safely returns `root_gone_best_effort` without live stopper).** CONFIRMED.
  `preObservation.state === "gone"` returns immediately; `exactExecutionStopper.stop` is never referenced on this
  path. Verified in isolated execution (see "Independent bug reproduction" below) and by
  `mechanismGonePredecessorGrokR1Behavior.gen.test.ts`, `deliveryLeaseService.test.ts` ("completes mechanism-only
  review/handoff when predecessor is already gone without invoking stopper" — asserts `stop` not called, `observe`
  called exactly once with the exact persisted identity).

- **H2 (pre-alive still calls stopper exactly once and post-observes gone).** CONFIRMED.
  `deliveryLeaseService.test.ts` ("completes mechanism-only review after pre-alive stop then post-gone
  observation") asserts `stop` called exactly once with the correct `deliveryId/segmentId/executionNonce/process`,
  and `observe` called exactly twice (pre then post). The "outside the worktree lock" test was updated to a
  two-call alive→gone sequence and asserts `observations === 2`, confirming both calls still execute outside any
  lock.

- **H3 (unknown/malformed/missing observer fail before stop and quarantine).** CONFIRMED.
  Order of checks in the source guarantees this: the missing-observer/missing-identity guard runs before any
  `observe()` call; `validProcessObservation` is checked before dereferencing `.state`; `unknown` throws
  immediately after the pre-observation, before the stopper-availability check. `deliveryLeaseService.test.ts`'s
  parametrized quarantine table explicitly covers `unknown pre-observe`, `malformed pre-observe`, and
  `missing observer`, each asserting `expectStop: false` / `observe` called the expected number of times (1, 1,
  and 0 respectively — the omit-observer case is asserted with `expect(observe).not.toHaveBeenCalled()`).

- **H4 (stopper failure / post-alive / post-unknown quarantine).** CONFIRMED.
  Same table covers `stopper failure after alive` (stop throws → quarantine, fence untouched), `post-stop alive`
  (pre-alive → stop → post observe alive again → quarantine), `post-stop unknown`, `post-stop malformed` — all
  assert `code: "DELIVERY_QUARANTINED"`, correct `stop` call count/args, correct `observe` call count, and that
  `fence.capability/freeze/terminate/proveEmpty` are never touched (mechanism-only must never fall through to
  process-fenced side effects). The pre-existing "quarantines a mechanism-only handoff when post-absence
  inspection finds dirty/moved-HEAD" tests were correctly updated from `stop` *called* to `stop` *not called*,
  since a gone-predecessor path (used by those fixtures) no longer invokes the stopper at all.

- **H5 (process-fenced semantics, lock boundaries, replay, worktree inspections unchanged).** CONFIRMED.
  `git diff` on the process-fenced branch, `heldBoundaryFailure`, `replayHandoff`/`replayDrain`/
  `replayReviewDrain`, `assertInspection`/`assertReviewInspection`, `quarantineAndThrow`/`quarantineReviewAndThrow`,
  `reconcileHolder`, `types.ts`, `store.ts`, and `reloadReconciliation.ts` is empty — none of these were touched.
  The only structural change is intra-function reordering/conditionalization inside the mechanism-only branch of
  `establishTransferAbsence`.

- **H6 (PID reuse/identity drift cannot be mistaken for gone).** CONFIRMED, and this guarantee is untouched by the
  diff. The real `processObserver`/`exactExecutionStopper` wiring in `Workspace.ts` (unchanged: `git diff` on that
  file is empty) is layered on `readLinuxProcessIdentity` in `reloadReconciliation.ts` (also unchanged), which
  returns `"gone"` **only** on `ENOENT` reading `/proc/<pid>/stat` — i.e., only when the kernel confirms no process
  occupies that PID at all. If a PID were reused by an unrelated process before observation, `/proc/<pid>/stat`
  would succeed (`state: "exact"`), and `Workspace.ts`'s wiring (`observed.processStart === identity.processStart
  && observed.bootId === identity.bootId`) would then diverge on `processStart`/`bootId`, producing `"unknown"`
  (fail-closed), never `"alive"` and never `"gone"`. A live reused-PID process can never be reported `"gone"`; a
  drifted identity can never be reported `"alive"`. Both observer call sites in `establishTransferAbsence`
  (pre and post) pass a fresh `structuredClone(holder.process)` of the same persisted identity, so pre/post
  comparisons and the stopper's own identity cross-check (`panePid !== input.process.pid || observed.processStart
  !== input.process.processStart || observed.bootId !== input.process.bootId` in `Workspace.ts`) all operate on
  the same immutable durable identity — no risk of comparing against a silently-refreshed value.

- **H7 (both out-of-scope generated test migrations are necessary and truthful).** CONFIRMED — audited both
  by diff, not assumed:
  - `deliveryMechanismB2TerraR1Behavior.gen.test.ts`: the fixture's `processObserver.observe` previously returned
    an unconditional `{ state: "gone" }`. Under the new pre-observe semantics that would make the lifecycle test's
    "stopped" bookkeeping assertion (which expects the stopper to run and record `executionAgent`) fail, since a
    pre-observed "gone" predecessor now never invokes the stopper. The migration makes `observe` key on
    `pid:processStart:bootId` and return `alive` on the first call, `gone` thereafter — i.e., every transfer in
    this multi-segment lifecycle test now genuinely starts pre-alive, is stopped once, then observed gone
    post-stop. This is a faithful behavioral adaptation, not a weakening: it preserves the original test's intent
    (stop is exercised and recorded) while being honest about the new pre-observe algorithm. Confirmed passing.
  - `deliveryMechanismLeaseTerraR1Behavior.gen.test.ts`: two changes. (1) The "never impersonates proven_empty"
    happy-path test now asserts `stop` **not** called (previously asserted it *was* called with specific args) —
    correct, because this fixture's observer always returns `"gone"`, and a pre-gone predecessor must not invoke
    the stopper under the fixed semantics; the test comment makes the invariant explicit. (2) The parametrized
    quarantine table was restructured from a single `observation` value + `hasStopper` flag into an
    `{ sequence, hasStopper, stopThrows?, omitObserver? }` shape supporting the pre/post two-call sequence (e.g.
    `"alive"` case now feeds `[alive, alive]` to exercise pre-observe-alive → stop → post-observe-still-alive →
    quarantine, rather than a single-shot `alive` under the old single-observation model). Every case still
    asserts `code: "DELIVERY_QUARANTINED"`, quarantined persisted state, and zero ProcessFence side effects — the
    original test's guarantees are strictly preserved, just re-expressed for the new call cardinality. Both files'
    changes are minimal, mechanically necessary consequences of the semantic reordering, not scope creep or
    waiver-hiding; I did not find any assertion weakened beyond what the new algorithm requires.

- **H8 (workspaceHeadless test reproduces cleanly-ended predecessor, proves exactly one worktree/GitDelivery).**
  CONFIRMED. `test/unit/workspaceHeadless.test.ts`'s new case spawns a real `implementer` agent under
  `handoffSafety: mechanism-only` with `fakeTmux({ realPaneProcesses: true })` (so `panePid` reads a genuine OS
  process), captures the durable holder identity, calls `ws.manager.kill("implementer")` to cleanly end it
  (asserts the tmux session is gone and the child process has exited), then joins a `reviewer` onto the same
  delivery via `deliveryJoin`. This exercises the exact production code path: `Workspace.prepareDeliveryJoin`
  (`src/workspace/Workspace.ts:2392–2404`) calls `deliveryLease.handoff(...)` whenever `lease.state === "held"`,
  which is exactly the `establishTransferAbsence` caller fixed here — confirming the integration test targets the
  real reported incident, not just the unit-level abstraction. Assertions: the reviewer's cwd resolves to the
  *same* canonical worktree, the delivery stays `held` with the reviewer as new holder, segment roles are
  `["implementer", "reviewer"]`, exactly one `GitDelivery` entry exists for this delivery id, and exactly one
  worktree directory exists under the worktree base — directly proving no duplicate worktree/GitDelivery was
  created and the existing worktree was reused, matching the "already-gone predecessor handoff quarantined" /
  reusable-worktree framing from the dogfood incident.

## Independent bug reproduction (proves the fix, not just the tests)

I did not trust the coordinator's own test to prove the base commit was actually broken — I isolated it. Using a
throwaway `git worktree add --detach 29753ac2` (base setup commit, unmodified `leaseService.ts`), symlinked
`node_modules` from the candidate, copied *only* the candidate's final
`mechanismGonePredecessorGrokR1Behavior.gen.test.ts` on top of the base's 7-line stub, and ran it in isolation
against the **base** production source:

```
❯ mechanism-only handoff accepts an already-gone exact predecessor without invoking stopper
  → DELIVERY_QUARANTINED: handoff could not establish a safe successor boundary
    {"phase":"exact_root_stop","handoffSafety":"mechanism-only",
     "error":"stopper must not run for an already-gone predecessor"}
```

This independently confirms, by direct execution rather than by reading the diff, that base `29753ac2` invokes the
stopper unconditionally and quarantines an already-gone predecessor — reproducing the exact incident. The same
test passes cleanly against the candidate (see below). The throwaway worktree was removed after the run; the
candidate tree was never touched by this reproduction (a separate `git worktree add`, not an edit to the
candidate's checkout).

## Focused verification run (no full suite, per task scope)

```
npm run typecheck                                                         → clean, no errors
npx vitest run \
  test/unit/deliveryLeaseService.test.ts \
  test/unit/deliveryMechanismB2TerraR1Behavior.gen.test.ts \
  test/unit/deliveryMechanismLeaseTerraR1Behavior.gen.test.ts \
  test/unit/mechanismGonePredecessorGrokR1Behavior.gen.test.ts \
  test/unit/workspaceHeadless.test.ts
  → Test Files  5 passed (5)
    Tests       204 passed (204)
```

Candidate tracked tree confirmed clean (`git status` → nothing to commit) both before and after this review;
no fixes were applied.

## Verdict

**ACCEPT.** The fix is minimal and precisely scoped to the reported defect: it reorders the mechanism-only
absence check from stop-then-observe to observe-then-conditionally-stop-then-observe, without touching
process-fenced semantics, lock boundaries, replay/CAS logic, or the identity-drift defenses in the real
`Workspace.ts`/`reloadReconciliation.ts` wiring. All eight hypotheses are confirmed by direct source inspection,
by the updated/added unit and integration tests, and by an independent isolated reproduction proving the base
commit was genuinely broken and the candidate genuinely fixes it. Both out-of-scope generated test file edits are
necessary, truthful migrations forced by the semantic reordering — no waiver-hiding or assertion-weakening found.
