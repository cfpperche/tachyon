# SDD 368 T14 reload reconstruction — Sonnet R1 independent review — FINDINGS

Reviewed immutable candidate `56a7295ff5ae62022ea7962150275654ebcf9372` (branch
`tachyon/deliveryReloadT14GrokR2`, worktree `/home/goat/.cache/tachyon/worktrees/b349073a/deliveryReloadT14GrokR2`)
against the governing architecture (`docs/specs/368-delivery-worktree-leases/notes.md`, "T14 implementation
contract", "T14 R1 coordinator audit", "T14 R2 coordinator audit" at main `a647eb43`). Net implementation range
`c4be391c..56a7295f`; correction range under direct scrutiny `a3f14456..56a7295f`. Traced
`Workspace._create`/`start`/`refreshDeliveryReloadSnapshot`, `AgentManager.spawn`/`assertNotDeliveryLifecycleDenied`/
`isDeliveryLifecycleDenied`/`findLedgerWorktreeOccupant`, `planResume`, `reloadReconciliation.ts`
(`classifyHeld`/`resolveUniqueLinkedWorktree`/`sessionPathsExact`), `extension.ts`'s workspace-creation call sites,
and the full new/changed test surface, plus the canonical verification record
(`.tachyon/verifications/56a7295ff5ae62022ea7962150275654ebcf9372.json`, verdict `blocked`).

## Disposition of the canonical block

Canonical `verify_task` is blocked at the `affected_tests` tier (exit 1) before the behavior verifier even runs.
I reproduced the exact command from the record
(`npx vitest related --run src/agents/AgentManager.ts src/delivery/reloadReconciliation.ts src/resume/SessionLedger.ts
src/resume/planResume.ts src/workspace/Workspace.ts test/helpers/boundDeliveryExecutionHarness.ts
test/unit/agentManager.test.ts test/unit/deliveryReloadReconciliation.test.ts
test/unit/deliveryReloadT14GrokR2Behavior.gen.test.ts test/unit/resume.test.ts test/unit/workspaceHeadless.test.ts`)
and got the same result: **27 failed, 693 passed** across 5 files
(`continuityWiring.test.ts`, `cxNoticeBehavior.gen.test.ts`, `cxReuseFixBehavior.gen.test.ts`,
`ocGhostQBehavior.gen.test.ts`, `resumeTokenProof.test.ts`), every failure the identical error:
`Error: cannot spawn '<name>': Delivery lifecycle is unavailable for this agent (reload deny or Delivery marker);
use explicit deliveryJoin recovery`.

This is not a flaky/incidental block — I traced it to a genuine design gap, and independently answered the
contract's central question ("is this a real product/API compatibility defect... production can `Workspace.create`
with `autostart=false` and expose manual actions before start?"). **Yes, it is real.**

## Findings

### F1 — HIGH: fail-closed-by-default now denies every generic spawn/resume/restart for any Workspace that has not yet called `start()` — including the documented on-demand workspace-creation path, not just the store-read-failure case it was meant to close

`Workspace.ts:265-268` (R3, new):

```
private deliveryReload:
  | { phase: "uninitialized" }
  | { phase: "ready"; snapshot: ReloadReconciliationSnapshot }
  | { phase: "failed"; reason: string } = { phase: "uninitialized" };
```

`Workspace.ts:521-524`:

```
isDeliveryLifecycleDenied: (name) => {
  if (this.deliveryReload.phase !== "ready") return true;
  return this.deliveryReload.snapshot.unavailableAgents.has(name);
},
```

`this.deliveryReload` starts `{ phase: "uninitialized" }` at construction and only becomes `"ready"` inside
`refreshDeliveryReloadSnapshot()` (`Workspace.ts:2255-2300`), which is called from exactly one place:
`Workspace.start()` (`Workspace.ts:2801-2807`). There is no other path to `"ready"`. R3 correctly closed R2's
finding #1 ("a store-read failure re-enables generic lifecycle") by also treating `"uninitialized"` as deny-all —
but `"uninitialized"` is not a transient window that only a store failure produces; it is the *permanent* resting
state of any `Workspace` for which `start()` is never called, and `start()` is explicitly **not** called on every
production construction path.

`extension.ts:855-874` (`addWorkspace`) only calls `ws.start()` `if (autostart && hasConfig(folderPath))`. Of its
four call sites, one passes `autostart=false`: `ensureWorkspaceFor` (`extension.ts:879-881`), whose own comment
states its purpose — *"Boot a folder on demand — used by creation commands so a fresh folder gets a Workspace the
moment the user ACTS (Init / New Agent / Studio), not just by having the extension installed."* For a `Workspace`
constructed this way, `deliveryReload.phase` stays `"uninitialized"` indefinitely unless the user separately runs
the `"Tachyon: Start"` command (`extension.ts:1915-1919`) — nothing else calls `.start()`.

Worse, `_create()` wires `onConfigChange` (`Workspace.ts:1649-1658`) **before** any `.start()` call, and that
handler fires `void ws.autostartNewlyDeclared(agentsBefore)` on every `tachyon.yml` edit — exactly what "New
Agent"/"Init"/"Studio" do. `autostartNewlyDeclared` (`Workspace.ts:2865-2878`) calls `this.manager.spawn(name)`
(ordinary generic spawn, no `deliveryJoin`) inside a try/catch that surfaces any non-"already running" failure as a
user-visible **error** notification (`this.host.notify(..., "error")`). So: a user runs "New Agent" in a brand-new
folder with zero Deliveries, checks "autostart", saves — and gets `autostart of '<name>' failed: cannot spawn
'<name>': Delivery lifecycle is unavailable for this agent (reload deny or Delivery marker); use explicit
deliveryJoin recovery`, an error that has nothing to do with anything the user did. Any subsequent manual
`spawn_agent` Bridge call in that same workspace fails identically until `"Tachyon: Start"` is run once.

**This is exactly what the 27 test failures reproduce**, not incidentally: `test/unit/continuityWiring.test.ts`'s
`makeWs()` helper (`continuityWiring.test.ts:100-107`) does `await Workspace.createForTest(...)` then immediately
`await ws.manager.spawn("claude")` with no `.start()` in between — the identical shape as `ensureWorkspaceFor` +
config-change autostart. The candidate's own `test/unit/workspaceHeadless.test.ts` diff confirms the implementer
recognized this: it patches `makeWorkspace()` to default to `if (opts.start !== false) await ws.start();` and hand-
inserts `await ws.start(); // T14/R3: generic spawn requires ready reload snapshot` at several direct
`Workspace.createForTest` call sites within that one file. But the five failing files above are **outside T14's
declared owned paths** (`docs/specs/368-delivery-worktree-leases/notes.md:1720-1725` lists exactly ten paths plus
the harness/stub; none of the five are on it), so they could not be patched inside this candidate's scope even
though they demonstrate the same reachable production gap. The T14 contract itself anticipated this class of
problem — *"Stop and report if the production seams require widening"* — but this candidate instead patched only
the one in-scope test file and left the cross-cutting compatibility break unresolved and unreported as a scope
question.

**Not mine to design a fix**, but note the shape: the R2 finding this closes was specifically about a *read
failure after an attempt*, which is correctly now `{ phase: "failed" }`. Collapsing `"uninitialized"` into the same
deny-all bucket as `"failed"` conflates "we tried and it broke" with "we haven't tried yet, and for entire classes
of on-demand `Workspace` construction, may never try." A workspace with no Deliveries at all should not need an
explicit reload reconciliation pass to unblock a brand-new agent's first spawn.

## Audit of the four targeted R3 closures (all correctly implemented in isolation)

1. **Store-read failure fail-closed while explicit `deliveryJoin` still works** — `Workspace.ts:2801-2810` now
   catches `refreshDeliveryReloadSnapshot()`'s throw and sets `{ phase: "failed", reason }` instead of leaving the
   snapshot `undefined`; `isDeliveryLifecycleDenied` treats `"failed"` the same as `"uninitialized"` (deny-all).
   The new `workspaceHeadless.test.ts` regression ("store-read failure is explicit fail-closed") forces a real
   `ws.deliveries.list()` throw and proves zero generic launches/offers, a rejected direct `spawn`/`resume`/
   `restart`, `resumeReadiness() === false`, `autostartPending()` excluding the agent, **and** that an explicit
   `deliveryJoin` spawn still succeeds. This is a genuine, honest proof, not a narrower stand-in.
2. **Existing realpath worktree** — `reloadReconciliation.ts`'s `canonicalPath`/`pathsEqual` (which fell back to
   `path.resolve` on a failed `realpathSync`, letting two identical-but-nonexistent path strings compare equal) is
   replaced by `existingCanonicalPath`/`pathsEqualExisting`, which return `undefined`/`false` on a missing path;
   `sessionPathsExact` and `resolveUniqueLinkedWorktree` both now require a real, realpath-resolvable worktree
   before returning `held`/`ok`. Correct and matches the R2 ask precisely.
3. **Tail `grantedHeadSha`/principal boundary** — `classifyHeld` (`reloadReconciliation.ts:229-238`) gained
   `tail.grantedHeadSha !== expectedHead` and `tail.principal !== holder.principal` checks, mirroring the durable
   lease service's held-boundary predicate as instructed, without using principal for occupant-authority inference
   elsewhere (comment: "Principal equality only — never infer occupant authority from principal alone").
4. **cwd-or-worktree occupancy** — `findLedgerWorktreeOccupant` (`AgentManager.ts:1245-1298`) now gathers a
   candidate when *either* `rec.cwd` or `rec.worktree.path` resolves under the target root, computes
   `boundPathMismatch` for any bound row whose cwd/worktree disagree or one side is missing, and folds that into
   `invalid` → reported as `dead` (dirty), correctly blocking reuse rather than silently treating a cwd-drifted
   bound row as free. Matches the R2 ask.

I looked for the other risk categories named in the review contract beyond F1: no evidence of a start-twice hazard
(`refreshDeliveryReloadSnapshot` is a pure read recomputation, idempotent to call again via a second `"Tachyon:
Start"`); no stale-snapshot correctness gap beyond documented, in-scope T15-deferred behavior (a genuine Delivery
marker on a row is always re-checked live via `hasDeliveryMarker`, independent of snapshot staleness — only the
narrower marker-less crash-window set is snapshot-scoped, which is the explicitly intended, documented shape); no
unsafe worktree reuse beyond what's already fixed by closures 2 and 4 above.

## Allowed verification (as scoped by the review contract)

- `npx vitest related --run <the eleven canonical-gate paths>` — reproduced the canonical block exactly: 27 failed, 693 passed, all failures `AgentManager.assertNotDeliveryLifecycleDenied` throwing on an ordinary generic spawn in a `Workspace` that never called `start()`.
- `npm test -- --run test/unit/deliveryReloadT14GrokR2Behavior.gen.test.ts test/unit/deliveryReloadReconciliation.test.ts` — 2 files, 16 tests, all green.
- Confirmed fail-BASE/pass-HEAD for the canonical behavior title independently: BASE (`c4be391c`) contains only `expect.fail("delegation not implemented yet")`; the prior candidate `a3f14456`'s own canonical record (`.tachyon/verifications/a3f14456559cdcae3792bf34aa6614f75c97ed01.json`) already proved `behavior_base_expect_fail` (exit 1) / `behavior_head_expect_pass` (exit 0) for the same title against the same BASE, and I confirmed the test still passes unchanged at `56a7295f`.
- `git diff --check c4be391c..56a7295f` — clean.
- No typecheck or full verification was run, per contract scope.

## Verdict

**FINDINGS.** Not accepted. F1 (HIGH) is a genuine, empirically-confirmed product/API compatibility regression —
not a test-harness artifact — that breaks the documented on-demand workspace-creation flow ("Init / New Agent /
Studio") for any workspace with zero Deliveries, and is exactly why canonical `verify_task` is blocked at the
`affected_tests` tier across five files outside this candidate's declared scope. The four specific R3 closures
(store-read fail-closed, realpath worktree existence, tail head/principal boundary, cwd-or-worktree occupancy) are
each correctly and honestly implemented and should be preserved; the defect is in the breadth of what
`"uninitialized"` now means, not in any of those four fixes.
