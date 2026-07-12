# SDD 368 T13 closure risk review R3 — FINDINGS

Reviewed immutable range `3e7c3b58..cf7c8e82` (single commit `cf7c8e82` "test(t-0b5723): migrate clean T13 B2
coverage" on branch `tachyon/deliveryBoundT13CleanR5`, worktree
`/home/goat/.cache/tachyon/worktrees/b349073a/deliveryBoundT13CleanR5`) against the revised T13 closure contract
(`docs/specs/368-delivery-worktree-leases/notes.md`, "T13 closure course correction and R3 risk review contract").
Scope per that contract: the full delta in `src/agents/AgentManager.ts`, `src/agents/forgetAgent.ts`,
`src/bridge/tools.ts`, the new `test/helpers/boundDeliveryExecutionHarness.ts`, and the surrounding
launch/token/materialization/session/ledger/cleanup call paths, plus current tests. Canonical `verify_task` for
`cf7c8e82` already ACCEPTs with no waiver
(`.tachyon/verifications/cf7c8e82d16947c5ea971944771f83aec591603e.json`); per the R3 contract, B3/B4 exhaustive
chaos-matrix absence is explicitly not a finding here.

Traced `spawn` → `spawnDeliveryJoin` → `spawnCore` → `cleanupFailedDeliveryExecution`, `forgetAgent`,
`removeEphemeralFootprint`, `stampBridgeClientBinding`, and `deliveryDefinitionSnapshot`, and cross-checked against
the pre-existing spec-364 bridge-client-rebind health-stamp invariant (`clientRebind.ts`, `runtimeOps/model.ts`) and
its own regression test (`agentManager.test.ts:2284-2317`, "persists an unwired outcome across spawn, restart, and
resume instead of retaining a prior binding").

## Findings

### F1 — MEDIUM: the R2 principal-preservation fix over-broadened its guard onto `stampBridgeClientBinding`, silently reviving a stale/wrong Bridge-wiring health stamp for a re-spawned declared principal (empirically reproduced)

`AgentManager.ts:1372-1390` (new in this commit):

```
const preservesDeclaredLedger = !!forced?.attempt && forced.attempt.mode === "declared" && !!this.opts.ledger?.get(name);
if (this.opts.ledger && !preservesDeclaredLedger && (adhoc || adapter || worktree || parent)) {
  ...
  this.opts.ledger.record(name, { def: defBlock, resume: resumeBlock, worktree, cwd, declared: !adhoc });
  if (forced?.attempt) forced.attempt.ledger = true;
}
// spec 364 — durable Bridge-client stamp after successful spawn with materialization.
if (!preservesDeclaredLedger) this.stampBridgeClientBinding(name, spawnBridge.wired);
```

`preservesDeclaredLedger` exists to stop a Delivery join from overwriting a persistent declared principal's `def`/
`resume`/`worktree`/`cwd` block with this transient join's own values — the correct fix for R2's F1 (destructive
cleanup wiping principal state). But the same flag also gates the **separate** `stampBridgeClientBinding` call,
which is not the same operation: `stampBridgeClientBinding` (`AgentManager.ts:1532-1541`) reads the existing ledger
row and spreads it (`{ ...rec, bridgeClient: { boundGeneration, wired } }`), so calling it does **not** touch
`def`/`resume`/`worktree`/`cwd` — it only refreshes the one field that must reflect *this* incarnation's actual
outcome. Its own doc comment states the invariant this candidate now breaks for the declared-Delivery-join path:
"A new process that did not receive Bridge wiring must replace a prior incarnation's `wired: true` stamp instead of
inheriting its healthy-looking durable state." That exact invariant has a dedicated regression test for the
ordinary spawn/restart/resume paths (`agentManager.test.ts:2284-2317`, "persists an unwired outcome across spawn,
restart, and resume instead of retaining a prior binding"), but that test only calls `manager.spawn(name, opts)`
directly — it never sets `forced.attempt`, so it does not exercise `preservesDeclaredLedger` and does not catch
this gap.

**Empirically reproduced**: instantiated a real `AgentManager` in the candidate worktree with a declared `reviewer`
agent whose ledger row already carried `bridgeClient: { boundGeneration: 3, wired: true }` from a prior
incarnation, then called `manager.spawn("reviewer", { deliveryJoin: {...} })` (no `cmd`, no `declared_agent` — the
existing, still-supported "ordinary declared-agent Delivery join" path, `mode === "declared"`) with this run's
Bridge wiring made to fail (`getExtraEnv` returns no `TACHYON_BRIDGE_URL`, `materializeBridgeMcp` returns
`undefined`, same fixture shape as the existing spec-364 test). Result:

```
bridgeClient after re-spawn with FAILED wiring: {"boundGeneration":3,"wired":true}
```

The freshly spawned session's real wiring outcome (`spawnBridge.wired === false`) is silently dropped; the row
keeps reporting `wired:true` from the previous, unrelated incarnation. (Repro test was run in-tree for
verification only and was not committed; worktree is clean, only this review artifact is staged.)

**Concrete failure scenario**: `codex-reviewer`-style declared agents are routinely re-spawned via a bare
`delivery_join` (no `cmd`, no `declared_agent`) to join a Delivery under their own name — this is the same pattern
this reviewer instance itself was spawned under. If that re-spawn's actual Bridge wiring silently fails (the
`getExtraEnv` comment on `Workspace.ts:505-513` already documents this as a real, expected transient window: "a
spawn in it just gets no per-agent token... before the Bridge itself has bound a port"), the ledger keeps
advertising a healthy `wired:true` inherited from whatever the agent's previous run happened to record. Two
concrete consequences: (1) `isTachyonBridgeWiredRecord`/`isWiredSuspect` (`clientRebind.ts:149-167`) will trust the
stale stamp and skip flagging/rebinding this genuinely broken session on the next host-generation bump, so the
self-healing rebind system never fixes it; (2) any other consumer of the durable `bridgeClient` field (e.g. the
RuntimeOps bridge-health projection, `runtimeOps/model.ts:155-176`) reports this unreachable agent as
Bridge-healthy. A reviewer/implementer that cannot actually reach its own Bridge (cannot `notify_agent`,
`get_task`, etc.) becomes invisible to the mechanism designed to detect exactly that.

Not mine to design a fix, but the shape is evident from `stampBridgeClientBinding`'s own merge semantics: the
`!preservesDeclaredLedger` guard on the `ledger.record(...)` call at line 1373 is doing real, necessary work (don't
overwrite the principal's own def/resume/worktree/cwd); the same guard reused on `stampBridgeClientBinding` at line
1390 is not needed for that purpose and should be dropped so every successful spawn — declared-Delivery-join
included — still gets its own accurate health stamp.

## Allowed verification (as scoped by the review contract)

- `npm test -- --run test/unit/agentManager.test.ts test/unit/bridge.test.ts test/unit/deliveryBoundT13CleanR5Behavior.gen.test.ts` — 3 files, 341 tests, all green (matches the canonical gate; confirms the reported result but not the gap in F1, which no current test exercises).
- `git diff --check 3e7c3b58..cf7c8e82` — clean.
- No typecheck or full verification was run, per contract scope.

## Verdict

**FINDINGS.** Not accepted. F1 is a concrete production defect on the currently-supported declared-Delivery-join
path (identity/health-state confusion: a genuinely unwired session is durably reported as wired), empirically
reproduced, and outside the acknowledged B3/B4 follow-up scope the R3 contract excludes. It is narrow — a
one-condition guard removal — but it silently defeats a purpose-built self-healing/observability invariant
(spec 364) for exactly the entry point (`codex-reviewer`-style declared re-spawns) this SDD depends on most.
