# SDD 368 T14 reload reconstruction — Sonnet R2 (final) independent review — ACCEPT

Reviewed correction range `56a7295ff5ae62022ea7962150275654ebcf9372..2059f42747f5478ac3492ac13fa4d18823798a2e`
and final net range `c4be391c..2059f427` (branch `tachyon/deliveryReloadT14GrokR2`, worktree
`/home/goat/.cache/tachyon/worktrees/b349073a/deliveryReloadT14GrokR2`) against my own prior R1 report
(`.tachyon/reviews/368-delivery-reload-t14-r1.md`, commit `ab787ab6`) and the closed R4 contract (`docs/specs/368-
delivery-worktree-leases/notes.md`, coordinator note `5b1d9be3`). The correction touches exactly three paths —
`src/workspace/Workspace.ts`, `test/unit/deliveryReloadT14GrokR2Behavior.gen.test.ts`,
`test/unit/workspaceHeadless.test.ts` — matching the granted scope; `src/agents/AgentManager.ts` and
`src/delivery/reloadReconciliation.ts` are untouched since `56a7295f`, so R1's four accepted R3 closures (store-read
fail-closed, realpath worktree existence, tail grantedHead/principal boundary, cwd-or-worktree occupancy) are
preserved by construction — no re-audit needed there.

## R1 finding F1 disposition — CLOSED

R1 F1 (HIGH): `deliveryReload` defaulted to `{phase:"uninitialized"}` and stayed there for any `Workspace` never
sent through `start()` — including the real `ensureWorkspaceFor("Init"/"New Agent"/"Studio")` construction path —
so every generic spawn (including config-change-triggered `autostartNewlyDeclared`) was permanently denied until an
unrelated, separate `"Tachyon: Start"` command ran. Empirically reproduced via 27 canonical-gate test failures
across 5 files outside T14's owned scope.

**Fixed correctly.** `Workspace._create()` now calls a new shared helper,
`attemptDeliveryReloadSnapshot()` (`Workspace.ts:2311-2325`: wraps `refreshDeliveryReloadSnapshot()`, success →
`{phase:"ready"}`, failure → `{phase:"failed", reason}` + a `"warn"` notify — identical shape to the R3 `start()`
handling, just factored out), and this call is inserted right after `ws.reloadConfig()` and — critically — **before**
`ws.bridge.start(preferred)` (`Workspace.ts:1629-1632`):

```
ws.reloadConfig();
// SDD 368 T14/R4 — one bounded Delivery reload before Bridge exposure or return,
// so ensureWorkspaceFor / createForTest never leave callers on `uninitialized`.
// start() still recomputes after rehydrate/GC (failed→ready retry + ledger truth).
await ws.attemptDeliveryReloadSnapshot();
if (seams.startBridge !== false) {
  ...
  const port = await ws.bridge.start(preferred);
```

This closes the gap at its root, not just at the test-file level: `_create()` is the **one** production
constructor behind both `Workspace.create` and `Workspace.createForTest`, so every caller — `ensureWorkspaceFor`
(autostart=false), the normal activation-time `addWorkspace(..., true)` paths, and every test — now gets a resolved
`"ready"`/`"failed"` phase before the function returns, and (for real production use) before the Bridge accepts any
`spawn_agent` MCP call at all. `onConfigChange`'s watcher (which fires `autostartNewlyDeclared` on every
`tachyon.yml` edit — the exact path a "New Agent" action drives) is registered later in the same `_create()` body,
so by the time it can fire, the phase is already resolved. `start()` unchanged in effect: it still recomputes via
the same shared helper after rehydrate/GC, so a `_create()`-time `"failed"` (e.g. a transient DB lock) can honestly
recover to `"ready"` on a later explicit `start()`, and the post-rehydrate snapshot reflects ledger truth rather
than the pre-GC one.

**Verified, not just read.** I independently reverted `Workspace.ts` to its `56a7295f` content in the worktree
(test files kept at HEAD) and re-ran the new forcing test:

```
FAIL test/unit/deliveryReloadT14GrokR2Behavior.gen.test.ts > ... > T14 R4 factory completes bounded reload so healthy pre-start generic spawn works
AssertionError: expected 'uninitialized' to be 'ready'
```

— confirming it is a real regression test, not a vacuous one, before restoring the worktree to `2059f427`. That new
test (`test/unit/deliveryReloadT14GrokR2Behavior.gen.test.ts:497-589`) builds a **real** `Workspace` (not a bespoke
mini-harness) via `Workspace.createForTest` with **no** `.start()` call — the same shape as `ensureWorkspaceFor` —
and asserts `deliveryReloadPhase() === "ready"` and that a plain `manager.spawn("prestart")` resolves and the agent
appears in `runningAgents()`. The rewritten `workspaceHeadless.test.ts` case ("factory ready pre-start; start
store-read failure deny-all + deliveryJoin; start retry failed→ready") is a single, honest end-to-end sequence
proving, in order: (1) `createForTest` alone yields `"ready"` and an unstarted ordinary spawn succeeds; (2) forcing
`ws.deliveries.list()` to throw and then calling `start()` explicitly moves the phase to `"failed"`, denies every
generic spawn/resume/restart/`resumeReadiness`/`autostartPending` entry while an explicit `deliveryJoin` spawn still
succeeds (R3's proof, re-verified against the new plumbing); (3) restoring the store and calling `start()` again
recovers to `"ready"` and unblocks a fresh generic spawn — the retry path is exercised for real, not asserted by
inspection.

## Re-checked the R2 contract's specific risk categories

- **Double-start/store side effects.** `attemptDeliveryReloadSnapshot()` now runs twice for any workspace that
  reaches `start()` (once eagerly in `_create()`, once again in `start()` after rehydrate/GC) — intentional per the
  contract ("recomputes after rehydrate/GC... reflects post-rehydrate truth"), read-only, and idempotent; the only
  observable duplication is a second identical `"warn"` toast if the store fails both times, a cosmetic non-issue.
- **Error swallowing.** No new swallowing: `attemptDeliveryReloadSnapshot` still notifies on failure and sets an
  explicit `"failed"` phase rather than silently discarding the error; unchanged from R3's already-reviewed shape.
- **Stale/partial snapshot.** `start()` still unconditionally recomputes, so any workspace that does start gets a
  post-rehydrate-accurate snapshot; a workspace that never calls `start()` keeps its one `_create()`-time snapshot,
  which is the intended, minimal behavior for that path and does not weaken the always-live `hasDeliveryMarker`
  check on genuinely bound rows.
- **Test falsehood.** Both new/changed tests were independently exercised against the pre-fix `Workspace.ts` above
  and shown to fail for the right reason; none of the assertions are tautological.

## Allowed verification (as scoped by the review contract)

- Reproduced the canonical `affected_tests` command exactly: **721 passed, 0 failed** across 45 files (vs. 27
  failed / 693 passed at `56a7295f`) — the regression is fully closed, not narrowed.
- Independently forced the new behavior test to fail against `56a7295f`'s `Workspace.ts` (shown above), then
  restored the worktree to `2059f427` (clean `git status` confirmed).
- `git diff --check 56a7295f..2059f427` and `git diff --check c4be391c..2059f427` — both clean.
- Canonical `verify_task` record (`.tachyon/verifications/2059f42747f5478ac3492ac13fa4d18823798a2e.json`): `accept`,
  no waiver; typecheck green; `behavior_head_expect_pass` (exit 0) / `behavior_base_expect_fail` (exit 1) for the
  canonical title against the original `c4be391c` stub.
- No typecheck or full verification was re-run by me, per contract scope (already canonically green).

## Verdict

**ACCEPT.** F1 is genuinely closed at its root cause (Bridge/manual-action exposure now strictly follows the reload
attempt in the one shared `_create()` path, not layered around individual call sites), the fix is scoped to exactly
the granted three paths, the new regression tests are real and independently verified to fail without the fix, and
all four R3 closures from R1 remain intact untouched. No concrete HIGH/MEDIUM defect or test falsehood found in
this correction.
