# SDD 368 T6 R1 — adversarial review of `2ed9d48..146e602`

**Verdict: FINDINGS**

Scope: `2ed9d48` (`feat(t-0b5723): add no-fallback delivery join spawn path`) and `146e602`
(`test(t-0b5723): lock delivery join bridge boundary`) — `src/agents/AgentManager.ts`,
`src/bridge/tools.ts`, `test/unit/agentManager.test.ts`, `test/unit/bridge.test.ts`. T6's stated gate
(`docs/specs/368-delivery-worktree-leases/tasks.md`) is "successor acquire reuses one worktree and never
forks an occupied Delivery." Real `DeliveryLeaseService`/`ProcessFencePort` wiring (T7) is not part of this
diff and current production has no caller that sets `prepareDeliveryJoin`/`confirmDeliveryJoin` — verified
by `grep -rn "prepareDeliveryJoin\|confirmDeliveryJoin\|failDeliveryJoin"` across `src/`, which returns
zero hits outside `AgentManager.ts` itself. So today `spawnDeliveryJoin` always throws
`DELIVERY_LEASE_UNAVAILABLE` (`AgentManager.ts:814-816`) before touching a worktree; every finding below is
about the *contract* T6 hands to T7, not a reachable production bug today.

Reviewed against the task's four focus areas: fallback creation, live-runtime/phantom-reservation after
failure, delegation-contract bypass, and cwd/parent correctness — plus test truthfulness.

## F1 — HIGH — compensation failure is silently swallowed, leaving a live runtime + a released reservation with zero signal

`spawnDeliveryJoin` (`AgentManager.ts:813-828`):

```ts
} catch (error) {
  if (spawned) {
    try { await this.kill(name); } catch { /* compensation below remains authoritative and fail-closed */ }
  }
  try { await this.opts.failDeliveryJoin?.(name, request, prepared, error); } catch { /* preserve the launch/confirm failure */ }
  throw error;
}
```

When `spawnCore` succeeds (`spawned = true`) but `confirmDeliveryJoin` then fails — e.g. because the
durable segment-append it's presumably responsible for lost a race, or its own store write failed — the
code tries to `kill(name)` and unconditionally calls `failDeliveryJoin` regardless of whether the kill
actually worked. Both catch blocks discard the error with a bare `catch {}` and no `notify`/`console.warn`.
The re-thrown `error` is always just the original `confirmDeliveryJoin` failure — it carries no information
about whether the runtime was actually torn down.

Concretely: if `kill()` fails for a real reason (tmux daemon hiccup, not just "already gone" —
`AgentNotRunningError` and a genuine `tmux.killSession` failure are caught identically), the agent process
is **still alive** in the Delivery's worktree. `failDeliveryJoin` still runs and — per the design in
`docs/specs/368-delivery-worktree-leases/plan.md:104` ("a valid transfer... writes a nonce-bound `pending`
successor reservation" / "spawn failure/timeout consumes the reservation into a retryable
failed-handoff/quarantine state") — is exactly the hook responsible for releasing/quarantining that
reservation. So the reservation gets released while the runtime is still writing to the worktree, and the
caller of `spawn()` sees a plain `Error: <confirm failure>` with no hint that cleanup didn't happen. This is
precisely the "live runtime / phantom reservation after failure" hazard the review was scoped to check, and
it directly threatens the spec's own non-goal ("Sharing one worktree between independent Deliveries",
`spec.md:210` neighborhood) once T7 wires a real successor grant on top of `failDeliveryJoin` returning
"clear to retry."

**Reproduced empirically** (probe against the real compiled `AgentManager`/`TmuxService` at `146e602`, not
a description — full script and commands below):

```
session was created (spawnCore succeeded): true
thrown error message: confirmation lost (simulated)
thrown error is AggregateError: false
failDeliveryJoin was called: true
failDeliveryJoin saw error message: confirmation lost (simulated)
session STILL tracked as live in fake tmux after failed kill: true
```

A real `tmux kill-session` failure during the confirm-failure compensation path leaves the session
provably alive while `failDeliveryJoin` still fires and the caller's error carries no trace of it.

**Test coverage gap matching the defect:** `test/unit/agentManager.test.ts`'s new test "SDD 368 T6
terminates a spawned successor when durable confirmation fails" (added in `2ed9d48`) only exercises the
happy path where `kill()` succeeds — it asserts `failed` fired and `runningAgents()` no longer contains
`successor`, but never makes `kill()` itself fail. `146e602` (the dedicated "lock delivery join bridge
boundary" commit) doesn't add coverage for this either — it only locks the Bridge-level
mutual-exclusion/contract/unavailable behaviors. So nothing in the reviewed range would have caught F1.

**Disposition note:** the very next commit on the branch, `81741bb`
(`fix(t-0b5723): surface incomplete delivery join compensation`, **outside this review's `2ed9d48..146e602`
scope**), replaces both bare `catch {}` blocks with a `compensationErrors` accumulator and throws an
`AggregateError` when either `kill()` or `failDeliveryJoin` fails, plus adds the missing regression test. Re-running
the identical probe against `81741bb` confirms the caller now gets:

```
thrown error message: Delivery join failed and compensation was incomplete
thrown error is AggregateError: true
```

That's a real fix for the *visibility* half of F1 (the caller/T7 can now detect and quarantine on incomplete
compensation) — the runtime is still left alive in this reproduction either way, which is expected: actually
proving termination is exactly what T7's `ProcessFencePort`/`proven_empty` work exists for, per
`plan.md:66-76`; `81741bb` correctly punts that to the caller rather than pretending `kill()` succeeded.
Since `81741bb` is not part of the commit range this review was asked to assess, F1 is reported as found in
`2ed9d48`/`146e602` as committed — flagging for whoever reconciles review scope with the fact that the
branch has already moved past it.

## Confirmed sound — fallback creation

No path exists from `spawnDeliveryJoin` back into `spawnCore`'s normal `resolveSpawnCwd` resolution.
`spawn()` (`AgentManager.ts:797-805`) dispatches `deliveryJoin` before the `reuseWorktree`/default branches
and never falls through. `spawnDeliveryJoin` itself either throws `DELIVERY_LEASE_UNAVAILABLE`
(no wiring) or calls `spawnCore(name, opts, { cwd: prepared.cwd, worktree: prepared.worktree })` — and
`spawnCore`'s `forced` branch (`AgentManager.ts:1097-1100`, "reuse_worktree's dedicated cwd channel...
bypasses `opts.cwd`/`resolveSpawnCwd` entirely") short-circuits `resolveSpawnCwd` unconditionally when
`forced` is set. Locked in by `agentManager.test.ts`'s "reuses the prepared Delivery worktree and never
invokes fresh-worktree resolution" (asserts `freshResolutions === 0` against an injected `resolveSpawnCwd`
that would have recorded a call) and "refuses unavailable joins without spawning or falling back" (same
assertion when `prepareDeliveryJoin` itself throws). Both reproduced by direct test run (below). T6's stated
gate holds.

## Confirmed sound — delegation-contract bypass

`delivery_join`'s mutual-exclusion check (`tools.ts:818-819`) runs *before* the `isAdhocAiAgent` contract
gate, but that only means the mutual-exclusion error wins when both would fire — it doesn't skip the
contract. A `delivery_join` ad-hoc spawn with no `task`/`context`/etc. still hits the same
`validateSpawnContract` path as any other ad-hoc spawn and is refused with the standard "needs a delegation
contract" error (confirmed by the "no contract" sub-case of `bridge.test.ts`'s new
"delivery_join is no-fallback, mutually exclusive, and still contract-gated" test, and by direct read of the
handler at `tools.ts:805-887`, which has no `delivery_join`-specific carve-out around the contract block).
`delivery_join` doesn't introduce a new bypass beyond the pre-existing `skip_contract_reason` escape hatch
that already applies uniformly to every ad-hoc spawn (`reuse_worktree` included) — not a T6 regression.

## Confirmed sound — cwd/parent correctness

`spawnCore`'s `parent` computation (`AgentManager.ts` — `const parent = adhoc && !opts?.gate && opts?.parent
&& opts.parent !== name ? opts.parent : undefined;`) is untouched by the `forced` parameter; `forced` only
overrides `cwd`/`worktree`, never `parent`. Since `deliveryJoin` can't combine with `gate`
(`AgentManager.ts:799-801`), a delivery-join spawn's `opts.parent` flows into `this.lineage.set(name,
parent)` exactly like a normal ad-hoc spawn — verified by the first `agentManager.test.ts` delivery-join
test passing `parent: "boss"` and by reading the lineage/ledger-write path, which doesn't branch on
`forced`. `isolatedWorktree` (`!!worktree`, true for a forced delivery-join worktree) also correctly feeds
the existing opencode-delegation-permission and transcript-isolation security checks — a delivery-joined
ad-hoc agent gets the same worktree-containment protections as a `gate`/`reuse_worktree` spawn, not a weaker
path.

## Test truthfulness

- `bridge.test.ts`'s "unavailable" sub-case is not a mock: `test/unit/bridge.test.ts` constructs its
  `AgentManager` (`new AgentManager({ tmux, wsHash: HASH, workspaceRoot: WS, getConfig, getMaxAgents })`,
  around line 85) with no `prepareDeliveryJoin`/`confirmDeliveryJoin` at all, so the assertion that
  `spawn_agent` returns `DELIVERY_LEASE_UNAVAILABLE` and leaves no tmux session genuinely exercises the
  real "T7 not wired" production path, not a stub standing in for it.
- The "refuses unavailable joins" `agentManager.test.ts` case is a *distinct* scenario from the Bridge one
  (wiring present but `prepareDeliveryJoin` itself throws, vs. wiring absent) — both are needed and both are
  present; no redundant/overlapping coverage passed off as two tests.
- The one gap is F1 above: the "terminates a spawned successor when durable confirmation fails" test's name
  promises compensation coverage but only exercises the case where compensation succeeds.

## Regression check

```
npm ci                                                          # fresh detached worktree at 146e602, per primer
git worktree add --detach <scratch>/wt-146e602 146e602
npx vitest run test/unit/agentManager.test.ts test/unit/bridge.test.ts   # 254/254 pass (200 + 54)
npx tsc --noEmit -p .                                            # clean
```

`npm run verify:full` intentionally not run per this review's constraints.

## Commands used

```
git show 2ed9d48 -- src/agents/AgentManager.ts src/bridge/tools.ts
git show 2ed9d48 -- test/unit/agentManager.test.ts
git show 146e602
git worktree add --detach <scratch>/wt-146e602 146e602 && npm ci
npx vitest run test/unit/agentManager.test.ts test/unit/bridge.test.ts
npx tsc --noEmit -p .
node_modules/.bin/vite-node <scratch>/probe_swallow.mjs      # F1: real TmuxService, kill-session forced
                                                               # to fail, against the real AgentManager class
git worktree add --detach <scratch>/wt-81741bb 81741bb        # disposition-only: confirm the next commit's fix
node_modules/.bin/vite-node <scratch>/probe_swallow_81741bb.mjs
git worktree remove --force <scratch>/wt-146e602
git worktree remove --force <scratch>/wt-81741bb
```

Probe scripts are scratch-only (session scratchpad plus detached `git worktree`s outside the review branch);
no product or test file was modified. `npm run verify:full` was intentionally not run per this review's
constraints.
