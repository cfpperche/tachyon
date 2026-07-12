# SDD 368 T13 adversarial review R2 — FINDINGS

Reviewed immutable range `0a4e1136..be23bd26` (single commit `be23bd26` on branch `tachyon/deliveryBoundT13FixR3`,
worktree `/home/goat/.cache/tachyon/worktrees/b349073a/deliveryBoundT13FixR3`) against the "T13 implementation
contract — declared-agent bound executions", the "T13 R1 consolidated correction contract", and the "T13
coordinator A1 completion contract" (`docs/specs/368-delivery-worktree-leases/notes.md:1009-1289`). Audited the
full delta in `src/agents/AgentManager.ts`, `src/agents/forgetAgent.ts`, `src/bridge/tools.ts`, the new
`test/helpers/boundDeliveryExecutionHarness.ts`, and the surrounding spawn/readiness/token/harness/ledger/tmux
call paths (`spawn`, `spawnCore`, `kill`, `dismissAdhoc`, `forgetAdhoc`, `removeEphemeralFootprint`) plus the
prior R1 report (`.tachyon/reviews/368-delivery-bound-t13-r1.md`, H1-H4) to confirm which findings this candidate
actually closes.

R1's H1 (vacuous generated stub) and H4 (shallow `harness`/`isolate` reference) are resolved: the stub now
imports/awaits a real helper matching a truthful behavior title, and `deliveryDefinitionSnapshot` uses
`structuredClone` on the whole source definition, not a mix of deep/shallow fields. R1's H3 (spawn/readiness
failure between token mint and `spawnCore` return orphaning footprint because compensation was gated on a local
`spawned` flag) is also resolved — cleanup now runs unconditionally in the catch block regardless of where the
failure occurred. **The fix for H3 is exactly what introduces F1 below**: making cleanup unconditional was correct
for the ephemeral/bound case but was not scoped away from the pre-existing "ordinary declared-agent join" path,
where `name` *is* a persistent principal, not an ephemeral clone.

## Findings

### F1 — HIGH: `cleanupFailedDeliveryExecution` unconditionally erases a PERSISTENT PRINCIPAL's durable footprint on any failed ordinary declared-agent Delivery join (empirically reproduced)

`AgentManager.ts:930-953` (new in this commit):

```
private async cleanupFailedDeliveryExecution(name: string): Promise<Error[]> {
  ...
  try { this.opts.revokeAgentToken?.(name); } catch (error) { phase("token revoke failed", error); }
  if (!absent) return errors;
  const memory = [ ...clears readyAgents/provisionalAgents/.../ , () => this.forgetAdhoc(name) ];
  for (const clear of memory) try { clear(); } catch (error) { phase("in-memory cleanup failed", error); }
  try { this.removeEphemeralFootprint(name); } catch (error) { phase("footprint cleanup failed", error); }
  try { this.opts.onKilled?.(name); } catch (error) { phase("killed callback failed", error); }
  return errors;
}
```

This is invoked from `spawnDeliveryJoin`'s catch block (`AgentManager.ts:922`) for **every** failed
`delivery_join`, with no check of `this.adhoc.has(name)` or the local `bound`/`ephemeral` flag. `removeEphemeralFootprint`
(`AgentManager.ts:1850-1858`) calls the now-hardened `forgetAgent()` (`forgetAgent.ts`), which independently
deletes the session-ledger row, activity log, session-owner rows, and — critically — the agent's private
harness/config home directory.

Compare this to the pre-existing, unchanged `kill()` right below it (`AgentManager.ts:1631-1660`), which gates the
identical call behind an explicit ephemeral check before ever touching durable state:

```
const wasAdhoc = this.adhoc.has(name);       // AgentManager.ts:1641
...
if (!persistent) {
  this.adhoc.delete(name);
  if (wasAdhoc) {                             // AgentManager.ts:1652 — the guard cleanupFailedDeliveryExecution lacks
    this.removeEphemeralFootprint(name);      // AgentManager.ts:1656
  }
}
```

The T13 contract's own architecture text states this exact invariant explicitly: "The current ad-hoc `cmd` join
and **ordinary declared-agent spawn remain compatible**" (`notes.md:1015`), and "**never** read, mint, revoke,
overwrite, stop, resume, or clean **the principal's live session**" (`notes.md:1046`, restated at `notes.md:1181-1182`:
"Never remove or rewrite the principal's cwd, resume/config home, token, harness, activity ownership, continuity
brief/state, or live tmux session"). `spawnDeliveryJoin` supports this "ordinary declared-agent spawn" path today
(no `cmd`, no `declared_agent` — `bound` is `undefined`, so `definition` stays `undefined` and `spawnCore` falls
back to `this.definitionOf(name)`, the agent's own real config entry; `forced.ephemeral` is `false`, so `adhoc` is
`false` and `this.adhoc.set` is never called for it). This is precisely how a declared reviewer (e.g. the pattern
used repeatedly for `codex-reviewer` throughout T7-T11 per the task journal) joins a Delivery under its own name.
If anything fails after `spawnCore` returns — most plausibly `confirmDeliveryJoin`, which talks to the
Delivery/lease store and can fail on version conflicts or contention, a documented, expected failure mode
throughout this SDD's own T1/T2/T9 history — `cleanupFailedDeliveryExecution` kills that agent's just-created
session and then unconditionally wipes its ledger row and its entire harness/config-home directory, exactly the
state `kill()` deliberately preserves for a declared agent one function away in the same file.

**Empirically reproduced** (not just traced): I instantiated a real `AgentManager` in the candidate worktree with a
declared `reviewer` agent that already had a pre-existing ledger row and a harness-home file
(`important-history`), then called `manager.spawn("reviewer", { deliveryJoin: {...} })` with no `cmd` and no
`declared_agent`, and made `confirmDeliveryJoin` throw (simulating store contention). Result:

```
ledger row survived: false   harness survived: false   session still tracked: false
```

Both the ledger row and the harness directory (with `important-history`) were deleted after a single transient
confirmation failure, for an agent that was never ephemeral. The repro script and test file were used only for
verification and were **not** committed (worktree is clean; only this review artifact is staged).

No existing test catches this: every current `deliveryJoin` test in `test/unit/agentManager.test.ts` and
`test/unit/bridge.test.ts` — including the ones this commit touches (`agentManager.test.ts:822-825`) — always
passes `cmd: "claude"` (genuinely ad-hoc), never exercises a bare declared-name join without `cmd`/`declared_agent`
through a failure path, so the gap is invisible to the reported-green focused suites.

Not mine to design a fix, but the shape is evident from `kill()`'s own pattern one function away: gate the
footprint-wipe/`onKilled` steps in `cleanupFailedDeliveryExecution` on whether `name` was actually ephemeral for
*this* call (i.e., `bound` was truthy or `opts.cmd` was set), not on session-absence alone.

### F2 — HIGH: the A1 "no sampling, seven-block" deterministic matrix is, for the third consecutive correction round, still almost entirely absent; the generated stub's title is unproven

The A1 completion contract (`notes.md:1226-1289`) was issued specifically because the prior candidate `b160cabd`
delivered "only a small sample of the required matrix," and it demands "**no sampling**" across seven named blocks.
This candidate's entire test delta is: 5 changed lines in `agentManager.test.ts` (a pre-existing error-message
rename), 12 new lines in `bridge.test.ts` (two refusal-only assertions), and one new 58-line helper
(`boundDeliveryExecutionHarness.ts`) exercising exactly one happy path and one readiness-rejection failure.
Checking the seven blocks by name:

| A1 block (`notes.md:1261-1282`) | Present in this candidate? |
|---|---|
| 1. Bridge success without `cmd` proves `appendInstructions`/`declaredAgent`/parent mapping | **No** — the two new Bridge tests (`boundNoContract`, `boundCmdConflict`) are both refusal cases; no Bridge-level test asserts a successful bound spawn reaches `AgentManager` with the right shape |
| 2. Happy path: harness/isolate/env, execution-only config home/token/ownership hook/tmux env, fresh-worktree-resolution zero-call, byte-identity principal continuity/activity/harness/ledger/resume/home/token/tmux snapshot | **Partial** — the helper checks `ledger.get("reviewer")` equality, minted-token list, session count, and the harness-marker file content, but the fixture agent declares no `harness`/`isolate`, and there is no assertion on continuity brief, activity-owner data, resume/config-home binding, tmux command/env snapshot, ad-hoc listing, or a `resolveSpawnCwd`/fresh-worktree-resolver call count |
| 3. Thirteen individually named pre-reservation refusals (unknown/terminal source, same name, config/ad-hoc/ledger/live-tmux/dead-tmux collision, reserved token env, `cmd+declared_agent`, `principal+declared_agent`, unsafe reviewer command, failed preflight), each proving zero reservation/mint/harness/ledger/tmux/callback/principal effects | **No** — 0 of 13 exist at the effect-counted `AgentManager` level; only 1 of the 13 (`cmd+declared_agent`) has even a Bridge-level existence check, and it asserts only an error message, not zero-effects |
| 4. Snapshot barrier: mutate nested harness/env/attention after reservation begins, assert execution used the pre-reservation clone; assert exactly one preflight | **No** |
| 5. Force `newSession` failure, readiness rejection, confirmation failure independently | **Partial (1/3)** — only readiness rejection (`rejectReadiness = true`) is forced; `newSession` failure and confirmation failure are not |
| 6. Independently force probe error, kill error+survivor, post-kill probe error, token-revoke error, early/middle footprint errors, killed-callback error, reservation-compensation error, with meaningful combinations, asserting exact `AggregateError` ordering | **No** — none of these seven+ cases exist; `cleanupFailedDeliveryExecution`'s ordering (the exact thing F1 lives in) is entirely unexercised by any test |
| 7. Stub imports/awaits the real helper; cleans temp dirs in `finally`; T6/T10 tests retained | **Yes** |

Of seven required blocks, one is fully done, two are partially done (one of those, block 5, at 1/3), and four are
completely absent — including block 6, which is the exact cleanup-ordering logic F1 lives in and which no test in
this repo currently exercises for either the declared or bound path. The generated behavior stub's title, "a bound
Delivery execution proves zero-effect refusals and complete failure cleanup," is not proven by its body: the
helper executes zero refusal cases and one of at least three required failure-injection paths. This is the same
category of gap the coordinator withheld both `672ba2e0` (R1) and `b160cabd` (A1) for, now recurring a third time
despite the A1 contract's explicit "no sampling" instruction.

## Allowed verification (as scoped by the review contract)

- `npx vitest run test/unit/deliveryBoundT13FixR3Behavior.gen.test.ts test/unit/agentManager.test.ts test/unit/bridge.test.ts --maxWorkers=1` — 3 files, 326 tests, all green (matches the executor's report; confirms the reported gate but not semantic completeness, per F2).
- `git diff --check` — clean.
- No typecheck or full verification was run, per contract scope.

## Verdict

**FINDINGS.** Not accepted. F1 is a production correctness/safety defect that violates T13's central invariant
(never silently alter a persisted agent's live session/footprint) and is empirically reproducible today through the
pre-existing, still-supported ordinary declared-agent join path. F2 is a contract-compliance and test-truthfulness
gap recurring for the third consecutive round despite an explicit "no sampling" instruction.
