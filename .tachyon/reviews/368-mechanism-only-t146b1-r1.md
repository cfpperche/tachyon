# SDD 368 T14.6B1 mechanism-only lease policy — Sonnet R1 independent review — FINDINGS

Reviewed candidate `25bc5c3f` against BASE `b5255604`, journal contract `j-04308c3abf30` (task `t-0b5723`).
Read the full `b5255604..25bc5c3f` diff (5 files, 147 insertions/40 deletions — `src/delivery/leaseService.ts`
134 lines, `src/delivery/types.ts` 3 lines, three test files) and the surrounding unchanged
`leaseService.ts` (replay/quarantine/reconcile methods, `ProcessFencePort`/`ProcessFenceEmptyProof` types).
Ran `tsc --noEmit` (clean), the three directly-touched suites (139/139 pass), and `git diff --check` (clean).
Canonical `verify_task` for `25bc5c3f` recorded ACCEPT with `full`
(`.tachyon/verifications/25bc5c3f45b62fe2addadb167fcad43051b8751f.json`), but the coordinator flagged material
undercoverage and possible regressions before integration — that caution is **correct**. I confirm two of the
six hypotheses as real, source-verified regressions (H1, H2), confirm the coordinator's undercoverage suspicion
(H3) as the root cause both went undetected, and confirm H4/H5 as sound. H6 is a compounding design gap tied to
H2 rather than an independently-forced defect.

## H1 — CONFIRMED regression: structured survivor/unknown proof evidence is lost

Before (`handoff()`/`completeReview()`, BASE `b5255604`), a failed fence proof placed the **entire**
`ProcessFenceEmptyProof` object into the quarantine evidence:

```ts
let proof: ... = { state: "unknown", reason: "fence did not complete" };
...
if (fenceError || proof.state !== "proven_empty") {
  return this.quarantineAndThrow(input, intent, predecessorHolder, { phase: "fence", proof, error: ... });
}
```

`ProcessFenceEmptyProof` (`src/agents/processFence.ts:1-4`) has three states, one of which carries real
forensic evidence: `{ state: "survivors"; pids: number[] }` — the specific PIDs that outlived containment,
exactly the data an operator needs to hand-kill or investigate a stuck quarantine.

After this diff, `establishTransferAbsence` (`leaseService.ts:1319-1336`) replaces the full proof object with a
freshly-constructed generic `Error`:

```ts
if (proof.state !== "proven_empty") throw new Error(`process fence proof was ${proof.state}${proof.state === "unknown" ? `: ${proof.reason}` : ""}`);
```

For `state === "survivors"`, the `pids` array is not referenced anywhere in this string — it is dropped
entirely, not even into the error message text. `transferFailureEvidence` (`leaseService.ts:1350-1355`) then
narrows the caught error down to `{ phase, handoffSafety, error: error.message }` — a flat string
(`"process fence proof was survivors"`), permanently losing the `pids` list before it ever reaches
`quarantineAndThrow`'s `evidence` parameter and the persisted `handoff_quarantined`/`review_invalid` event.
This is a confirmed, source-verifiable evidence-loss regression in strong (`process-fenced`) mode, not a
mechanism-only-only concern — it fires on the pre-existing `process-fenced` path too, since
`establishTransferAbsence`'s `process-fenced` branch is the direct replacement for the old inline logic.

**Fix shape** (not implemented by me): `establishTransferAbsence`'s thrown error (or a sibling return channel)
needs to carry the full `ProcessFenceEmptyProof` object through to `transferFailureEvidence`, which should merge
it into the evidence record (e.g. `{ phase, handoffSafety, proof, error }`) instead of collapsing to a message
string.

## H2 — CONFIRMED regression: capability/safety gate runs before replay lookup in all three entry points

`acquireInternal`, `handoff`, and `completeReview` all now do, in this order:

```ts
const handoffSafety = this.handoffSafety();
this.assertSafetyEnabled(handoffSafety);
if (handoffSafety === "process-fenced") this.assertFenceCapability();
... build intent ...
const replay = await this.replay*(...);   // <-- idempotent-replay lookup happens AFTER the gate
if (replay) return replay;
```

(`leaseService.ts:502-510` acquire, `:699-705` handoff, `:782-787` completeReview — identical pattern all
three places.) The gate throws `DELIVERY_LEASE_UNAVAILABLE` unconditionally before any lookup for a
previously-completed operation. Concretely: an operation that **already completed** under one
`handoffSafety`/capability state has a durable receipt; retrying it with the same `operationId` (a legitimate
crash-recovery or double-submit case, not a fresh attempt) should short-circuit to that receipt regardless of
what the *current* config says. Instead, if the config or capability has since changed — `disabled` after a
rollback, or `process-fenced` capability lost — the retry throws before the replay lookup ever runs, breaking
idempotency exactly at the moment a staged rollout (`disabled` → `mechanism-only` → `process-fenced`, per this
task's own design doc) changes the setting between the original completion and a retry. This is precisely the
scenario the contract calls out by name for `completeReview` ("completed-review replay remains independent of
current capability"), and I confirm the identical bug shape in `acquire`/`handoff` too — it is the same three
lines duplicated three times.

**Fix shape**: attempt the replay lookup first (using an intent built without requiring the safety/capability
gate to have passed), and only run `assertSafetyEnabled`/`assertFenceCapability` on the non-replay path that is
about to perform a fresh mutation.

## H3 — CONFIRMED severe undercoverage — and it explains why H1/H2 shipped

The contract's B1 forcing matrix names: *"free acquire, held handoff, review completion, same-Delivery CAS
loser, stop outside locks, exact gone, alive/unknown/throw, binding callback failure, post-stop dirty/HEAD
drift, replay at drain/reserve/complete, zero ProcessFence calls in mechanism-only, unchanged ProcessFence calls
in strong mode, and recovery refusal without strong proof."*

The entire test contribution in this diff is:
- `test/unit/deliveryLeaseService.test.ts`: **4 lines** — adds `handoffSafety: "process-fenced"` to two
  existing test-factory functions so pre-existing tests keep compiling/passing. Zero new test cases.
- `deliveryMechanismLeaseTerraR1Behavior.gen.test.ts`: **one** test — a single mechanism-only `handoff` happy
  path (stop succeeds, observe returns `gone`), asserting `fence.capability`/`proveEmpty` were not called and
  the persisted event detail. No failure branch.
- `deliveryMechanismOnlyLeaseT146B1Behavior.gen.test.ts`: **one** test — `disabled` refuses `acquire` before
  probing the fence.

That's two single-scenario happy/refusal tests against a ~13-row matrix. Not exercised at all: mechanism-only
`acquire`, mechanism-only `completeReview` (the method's entire new branch is untested), same-Delivery CAS
loser under the new gating, `alive`/`unknown`/stopper-throw failure branches of `establishTransferAbsence`,
`exactExecutionStopper.stop()` throwing, post-stop dirty/HEAD drift, and — critically — **replay of an
already-completed acquire/handoff/review-completion at all**, under any safety level. The absence of that last
row is exactly why H2's regression (and, downstream, its interaction with H1's evidence loss on retry) went
undetected: there is no test that completes an operation once and then retries the same `operationId`.

## H4 — verified correct: mechanism-only stop runs outside locks; all failure branches quarantine

`establishTransferAbsence` is invoked (`leaseService.ts:745-746`, `:817-818`) before
`withDeliveryLock`/`withWorktreeLock` is acquired for the second CAS, matching the code's own comment ("Runs
outside all Delivery/worktree locks after the durable held-to-draining CAS") and the contract's "stop outside
locks." Inside the mechanism-only branch (`leaseService.ts:1338-1349`): missing `executionNonce`/invalid process
identity/missing `exactExecutionStopper` throws before calling anything; `stop()` throwing propagates
un-caught to the `.catch()` at the call site; a missing `processObserver` synthesizes `{state:"unknown", reason:
...}` (fails closed, does not assume success); and any observed state other than `"gone"` throws. Every one of
these paths funnels through the same `.catch((error) => quarantineAndThrow(...))` / `quarantineReviewAndThrow`
call — there is no path that silently returns success or a reusable held lease on ambiguity. This part of the
contract is satisfied by the implementation (even though, per H3, it isn't test-forced).

## H5 — verified correct: recovery never consumes `handoffSafety`

`grep -n handoffSafety src/delivery/leaseService.ts` shows the identifier only inside `acquireInternal`,
`handoff`, `completeReview`, and their three new private helpers (`handoffSafety()`, `assertSafetyEnabled`,
`establishTransferAbsence`, `transferFailureEvidence`, `acquireIntent`). `reconcileHolder`
(`leaseService.ts:299-412`), `salvageQuarantineInternal`, and `abandonQuarantineInternal` have zero references
to it and are otherwise untouched by this diff; `reconcileHolder` still calls
`this.deps.processFence.capability()`/`proveEmpty()` directly and unconditionally
(`leaseService.ts:361,365`). Recovery methods remain byte-for-byte on real fence proof, matching the contract.

## H6 — compounding design gap tied to H2, not independently forced

`handoffSafety` is read fresh from `this.deps` (ambient config) on every call and embedded into a **new** intent
object each time (`acquireIntent(..., handoffSafety)`, and inline in `handoff`/`completeReview`), then compared
via `isDeepStrictEqual` against the *stored* intent from the original event. This means a receipt is not
actually "bound" to its recorded safety level in any validated sense — it's an incidental side effect of intent
deep-equality. For a retry where the *current* `handoffSafety` differs from the original (e.g. `mechanism-only`
→ `process-fenced`, both individually valid/enabled, so H2's outer gate doesn't block it), the intent comparison
would mismatch, `completedReplay`/`replay` would come back `undefined`, and execution would fall through to the
primary mutation logic against a Delivery whose lease is already `free`/no-longer-`held` — producing a confusing
invariant/occupied error rather than either a clean idempotent return or an explicit "safety level changed,
refusing" error. I found no test exercising this transition (consistent with H3), so I'm reporting it as a
design-level consequence of H2's root cause rather than a separately-confirmed defect. Fixing H2 by validating
replay against the *historically recorded* `handoffSafety` (rather than gating on the *current* one before any
lookup) would likely resolve this too.

## Verification run

- `tsc --noEmit -p tsconfig.json`: clean.
- `vitest run test/unit/deliveryLeaseService.test.ts test/unit/deliveryMechanismLeaseTerraR1Behavior.gen.test.ts test/unit/deliveryMechanismOnlyLeaseT146B1Behavior.gen.test.ts`: **139/139 pass**.
- `git diff --check b5255604..25bc5c3f`: clean.

## Verdict

**FINDINGS.** Two HIGH-severity, source-confirmed regressions: (H1) strong-mode `survivors` proof evidence
(the `pids` list) is silently dropped from quarantine records on the `process-fenced` path, not just
mechanism-only; (H2) the safety/capability gate in `acquireInternal`/`handoff`/`completeReview` runs before the
idempotent-replay lookup in all three entry points, breaking replay of already-completed operations whenever
current config differs from the original — the exact staged-rollout scenario this task exists to support. Both
went undetected because (H3) the entire diff added only two single-scenario happy/refusal tests against the
contract's ~13-row forcing matrix, with zero coverage of failure branches, mechanism-only `completeReview`, or
any replay-of-completed-operation case. H4 (stop outside locks, uniform quarantine on failure) and H5 (recovery
untouched by `handoffSafety`) are both correctly implemented. H6 is a real but not independently forced design
gap that likely resolves alongside a correct H2 fix. Recommend: do not integrate; fix H1 (preserve structured
proof/evidence through `establishTransferAbsence`/`transferFailureEvidence`) and H2 (replay lookup before the
safety/capability gate, all three entry points) in the same pass, then add the missing matrix rows — especially
replay-of-completed-operation across a safety-level transition, mechanism-only `completeReview`, and the
`alive`/`unknown`/stopper-throw failure branches — as truthful, forcing tests before re-requesting review.
