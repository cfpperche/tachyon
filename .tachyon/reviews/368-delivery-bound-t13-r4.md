# SDD 368 T13 closure risk review R4 — ACCEPT

Reviewed immutable correction range `cf7c8e82d16947c5ea971944771f83aec591603e..25f851cd7a366d9dc551abbb9bf0371c0039673a`
and final tree `25f851cd` (branch `tachyon/deliveryBoundT13GrokR6`, worktree
`/home/goat/.cache/tachyon/worktrees/b349073a/deliveryBoundT13GrokR6`, a Grok 4.5-implemented correction of R3's
finding, per the closed R4 review contract). `cf7c8e82` is not a git ancestor of `25f851cd` (fresh base `main` at
`0edee8ad`, common ancestor `8dae6ee5`); `git diff --stat cf7c8e82..25f851cd` therefore mixes real T13-relevant
changes with unrelated base drift (`docs/specs/.../notes.md`, `src/webview/handoff/*`, `tachyon.yml`,
`test/unit/handoffDistill.test.ts`, this reviewer's own R3 artifact — all landed on `main` between the two
candidates' branch points and out of scope here). Isolated the T13-relevant surface: `src/agents/AgentManager.ts`,
`test/helpers/boundDeliveryExecutionHarness.ts`, and the renamed generated behavior stub
`test/unit/deliveryBoundT13GrokR6Behavior.gen.test.ts`. `src/agents/forgetAgent.ts` and `src/bridge/tools.ts` do not
appear in the diffstat at all — byte-identical to `cf7c8e82`.

## R3 finding disposition

R3 F1 (MEDIUM): `stampBridgeClientBinding` was skipped whenever `preservesDeclaredLedger` was true, so an ordinary
declared-agent Delivery re-spawn (no `cmd`, no `declared_agent`) whose Bridge wiring genuinely failed on this
incarnation kept reporting a stale `wired:true` inherited from a prior run — empirically reproduced against a real
`AgentManager`.

**Fixed, exactly and minimally.** The entire `AgentManager.ts` diff between the two candidates is:

```
-    if (!preservesDeclaredLedger) this.stampBridgeClientBinding(name, spawnBridge.wired);
+    // Always stamp: preservesDeclaredLedger only protects principal def/resume/worktree/cwd
+    // from ledger.record; stampBridgeClientBinding merges bridgeClient alone and must
+    // reflect this incarnation's wiring (T13 R3 / t-0b5723).
+    this.stampBridgeClientBinding(name, spawnBridge.wired);
```

This is precisely the fix R3 pointed at — the guard is removed only from the health-stamp call, not from the
`ledger.record(...)` block eleven lines above (`AgentManager.ts:1372-1387`), which is unchanged and still reads
`if (this.opts.ledger && !preservesDeclaredLedger && (adhoc || adapter || worktree || parent))`. Confirmed
`stampBridgeClientBinding` itself is untouched (`AgentManager.ts:1534-1541`): it still does
`ledger.record(name, { ...rec, bridgeClient: { boundGeneration, wired } })` — a pure merge onto the existing row,
so calling it unconditionally cannot reintroduce R2's original principal-def/resume-overwrite bug (the two calls
protect genuinely different state; only the health-status field needed unconditional refresh).

## Checked against the six R4 acceptance invariants

1. **`preservesDeclaredLedger` still blocks the `ledger.record` overwrite of def/resume/worktree/cwd** — confirmed unchanged at `AgentManager.ts:1372-1387`.
2. **Every successful spawn stamps current `bridgeClient` via merge-only `stampBridgeClientBinding`** — confirmed; the guard is gone and the function body is unchanged (merge, not replace).
3. **No new cleanup/token/session/identity authority changes** — confirmed; the entire production diff is the one-line guard removal plus a 3-line comment. `forgetAgent.ts` and `bridge/tools.ts` are byte-identical to `cf7c8e82`.
4. **Regression exercises the real ordinary declared join and proves the exact scenario** — `exerciseDeclaredDeliveryJoinBridgeStampRefresh` (new, pure addition to `boundDeliveryExecutionHarness.ts`) calls `manager.spawn("reviewer", { deliveryJoin: {...} })` with no `cmd` and no `declared_agent`, pre-seeds the ledger with `bridgeClient: { boundGeneration: 3, wired: true }`, sets `getBridgeGeneration: () => 9` and `getExtraEnv: () => ({})` (no Bridge URL) so `withRuntimeBridge`'s codex branch (`AgentManager.ts:1499`, `if (!url) return { ..., wired: false }`) genuinely reports `wired:false` for this run, then asserts `after.def`/`resume`/`worktree`/`cwd`/`declared` all equal the pre-spawn snapshot while `after.bridgeClient` equals `{ boundGeneration: 9, wired: false }` and the session was actually created. This is the exact scenario from R3's empirical repro, not a weaker proxy.
5. **Generated behavior fails BASE, passes HEAD** — canonical `verify_task` record (`.tachyon/verifications/25f851cd7a366d9dc551abbb9bf0371c0039673a.json`) shows `behavior_base_expect_fail` at `eba81fc6` exiting 1 (`passed=0 failed=1`) and `behavior_head_expect_pass` at `25f851cd` exiting 0 (`passed=1 failed=0`), verdict `accept`, no waivers, no findings. I independently re-ran the exact behavior file at HEAD and got the same result (below).
6. **`cf7` frozen production/test body otherwise unchanged** — confirmed: the `boundDeliveryExecutionHarness.ts` diff is pure append (no lines removed/modified before the new function at line 339); the two pre-existing generated-stub tests (`exerciseBoundDeliveryExecution`, `exerciseBoundDeliveryIdentitySnapshot`) are carried over verbatim into the renamed stub file, plus the one new test.

## Allowed verification (as scoped by the review contract)

- `npm test -- --run test/unit/deliveryBoundT13GrokR6Behavior.gen.test.ts` — 1 file, 3 tests, all green.
- `git diff --check cf7c8e82..25f851cd` — clean.
- No typecheck or full verification was run, per contract scope (canonical `verify_task` already ran both at `.tachyon/verifications/25f851cd....json`).

## Verdict

**ACCEPT.** The correction is exactly scoped to R3's finding, minimal, semantically correct (distinguishes
identity-state protection from health-state refresh), independently proven by a regression that reproduces the
original empirical repro rather than a narrower stand-in, and canonically fail-before/pass-after verified. No new
concrete HIGH/MEDIUM defect or test falsehood found in the correction range. Per the R3 contract, deferred B3/B4
remains out of scope and is not a finding here.
