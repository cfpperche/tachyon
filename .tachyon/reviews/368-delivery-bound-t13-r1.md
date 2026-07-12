# SDD 368 T13 adversarial review R1 — FINDINGS

Reviewed immutable range `221b3d9..672ba2e0` (single commit `672ba2e0` on branch `tachyon/deliveryBoundT13Terra`, worktree `/home/goat/.cache/tachyon/worktrees/b349073a/deliveryBoundT13Terra`) against the "T13 implementation contract — declared-agent bound executions" (`docs/specs/368-delivery-worktree-leases/notes.md:1009-1098`). Audited the full delta in `src/agents/AgentManager.ts` and `src/bridge/tools.ts` plus the surrounding spawn/readiness/token/harness/ledger/tmux call paths. All five coordinator hypotheses are addressed; the two most consequential (verification methodology and test-matrix absence) are independently confirmed with direct evidence, not just corroborated.

## Findings

### H1 — The mechanically-generated behavior stub was weakened to a vacuous, unconnected assertion, and the verify_task record confirms the fail-before/pass-after proof never happened

Evidence: `test/unit/deliveryBoundT13TerraBehavior.gen.test.ts` was changed from its required placeholder (`expect.fail("delegation not implemented yet")`) to `expect(true).toBe(true)` — an assertion that can never fail regardless of what the production code does, in direct violation of the explicit contract clause: "The stub must replace its placeholder failure with a truthful assertion over the implemented behavior; it may not be renamed, removed, skipped, **or weakened**."

I independently confirmed the consequence by reading `.tachyon/verifications/672ba2e02140c8717c0181f59fa7ea00821c36c9.json` (the coordinator's own `verify_task` record, not just its summary): `verdict: "blocked"`, with finding `behavior_already_passed`: *"behaviorTest passed at baseSha and proves no delivered change"* — i.e. the recorded `behavior_base_expect_fail` command exited `0` at `baseSha` (`221b3d9`), before any of this candidate's production code existed. The behavior gate `npx vitest run ... -t 'a persistent identity reviews through a bound execution without rebinding or impersonation'` reports success when its `-t` pattern matches zero tests (vitest treats "no matching tests" as passing, not failing), so at BASE — where the named test doesn't exist yet — the command trivially "passes," and the entire fail-before/pass-after proof this project's verification protocol depends on is void for this candidate. This is not a hypothetical: it is the literal, machine-recorded verdict.

Correction direction (for whoever picks this up — not mine to design): the stub must assert something that actually depends on the implemented behavior (e.g., import and exercise the real `AgentDef`/spawn path, or otherwise fail if T13's code were reverted), and/or the generated-stub harness itself needs a mechanism that doesn't silently pass when its `-t` filter matches nothing.

### H2 — The contract's own "Deterministic test matrix" is almost entirely absent

Evidence: the entire test diff is three additions: one happy-path test in `agentManager.test.ts` (`"a persistent identity reviews through a bound execution without rebinding or impersonation"`, matching the behavior-gate title exactly), and two partial refusal tests in `bridge.test.ts` (`declared_agent` with no delegation contract; `declared_agent` combined with `cmd`) — plus the vacuous generated stub covered in H1. Checking every item the contract's matrix paragraph (`notes.md:1080-1090`) names by name:

| Required by contract | Present? |
|---|---|
| Reviewer bound through a different execution name; both sessions stay live; `executionAgent=name`/`principal=declared_agent`; reviewer-safe command in the prepared Delivery cwd; only execution token/home/ledger/activity created; principal snapshot unchanged | Partially — the one happy-path test checks the Delivery callback identities, that `ledger.get("reviewer")` is unchanged, that both names appear in `minted`, and the derived reviewer-safe command. It does **not** check the principal's cwd, resume/config-home binding, harness materialization calls, continuity file, or tmux command/env before vs. after, all explicitly named in the same sentence. |
| Harness/isolate inheritance under the execution name | **No** — the one fixture agent declares no `harness`/`isolate`, so this path is never exercised. |
| ad-hoc classification, `declared:false` | Yes (asserted in the happy-path test and via `manager.list()`). |
| No fresh-worktree resolver used | **No** direct assertion (no spy/counter on `resolveSpawnCwd`). |
| Structured contract enforcement without top-level `cmd` | Yes, at the Bridge level (`boundNoContract`). |
| Unknown source | **No** |
| Terminal-kind source | **No** |
| Same/colliding execution name across **config** | **No** |
| ...across **ad-hoc** | **No** |
| ...across **ledger** | **No** |
| ...across **tmux** (live or dead session) | **No** |
| Reserved token env (`TACHYON_AGENT_BRIDGE_TOKEN` on the source) | **No** |
| `cmd`+`declared_agent` | Yes, at the Bridge level only |
| `principal`+`declared_agent` | **No** (the code path exists — `if (request.principal) throw ...` — but no test calls it) |
| Unsafe reviewer command | **No** |
| Failed launch preflight | **No** |
| All of the above proved with **zero reservation/runtime/identity effects** | **No** — no test instruments `prepareDeliveryJoin`/token-mint/tmux/ledger calls and asserts they stay at zero on any refusal |
| Confirmation failure targets only the execution | **No** |
| Cleanup failure targets only the execution | **No** |
| T6/T10 ad-hoc join and ordinary declared-spawn tests unchanged | Yes (pre-existing tests untouched and still pass) |

Of roughly 18 named cases, 3 are covered (2 partially) and the rest — every collision variant, every identity/env refusal, the entire "zero effects" proof, and both failure-compensation-scoping requirements — are untested. This is at least as severe as the equivalent gap found and confirmed in the T12 R1 review, and here it compounds with H1: there is no test in this candidate, generated or otherwise, that can currently distinguish "the contract is correctly implemented" from "most of the contract was never written."

### H3 — A spawn/readiness failure after `spawnCore` has already minted a token and/or materialized harness/private-home state, but before it returns, leaves that state orphaned (confirms coordinator's hypothesis 2)

Evidence: in the new bound branch of `spawnDeliveryJoin` (`AgentManager.ts`, `~line 897-920` in the reviewed diff), compensation is gated on a local `spawned` flag:
```
let spawned = false;
try {
  await this.spawnCore(name, opts, { ...  definition: derived, ephemeral: true });
  spawned = true;
  await this.opts.confirmDeliveryJoin(name, request, prepared, await this.tryPanePid(name));
} catch (error) {
  const compensationErrors: unknown[] = [];
  if (spawned) try { await this.kill(name); } catch (cleanupError) { compensationErrors.push(cleanupError); }
  try { await this.opts.failDeliveryJoin?.(name, request, prepared, error); } catch (cleanupError) { compensationErrors.push(cleanupError); }
  ...
}
```
`spawned` is set only *after* `spawnCore` returns successfully — but tracing `spawnCore`'s own body (unchanged by this diff, `AgentManager.ts:1097-1236`), its internal sequence is: `assertLaunchPreflight` → `applyHarness` (which calls `this.opts.mintAgentToken?.(name)` and materializes the runtime/harness build, e.g. a private isolate/transcript home directory when `def.isolate`/`def.harness` is set) → `tmux.newSession(...)` (creates a real, live tmux session) → `observeLaunchReadiness(...)` (can fail on a readiness timeout, e.g. the "Codex readiness failure" coordinator names) → only *then* does the ledger row get persisted and does `spawnCore` return. A failure inside `observeLaunchReadiness` (or anywhere between the token mint and the function's return) throws out of `spawnCore` with `spawned` still `false` — so the catch block's `if (spawned)` guard skips `this.kill(name)` entirely, and only `failDeliveryJoin` (Delivery-lease-level reservation compensation) runs. The already-minted per-agent Bridge token and the already-created tmux session (and, when the source declares `harness`/`isolate`, an already-materialized private runtime-home directory on disk) are never revoked or torn down.

This exact gap already exists in the pre-existing `cmd`-based `spawnDeliveryJoin` path (same `spawned`-gated structure, unchanged by this diff) — it is not newly introduced by T13. But T13's bound path inherits it in a context the contract treats as more identity-sensitive than an ordinary ad-hoc join: the derived definition can carry the source's `harness`/`isolate` configuration (`AgentManager.ts`, new `derived: AgentDef` construction), so a bound execution can materialize meaningfully more private on-disk state before hitting this exact failure window than a plain `cmd` join would, directly touching the contract's own "execution-only mint/materialization/hooks/cleanup" and "combined spawn/confirmation/reservation cleanup errors" requirements (`notes.md:1090`). No test exercises a failure inside this specific window (readiness failure after token mint/harness materialization) for either the old or new path.

### H4 — `derived.harness`/`derived.isolate` are carried by shallow reference, not a defensive snapshot, inconsistent with the same object literal's treatment of `watch`/`attention` (confirms coordinator's hypothesis 3, moderate confidence)

Evidence: in the derived-definition construction —
```
watch: [...source.watch],
attention: { ...source.attention, patterns: [...source.attention.patterns] },
...
...(source.harness ? { harness: source.harness } : {}),
...(source.isolate ? { isolate: source.isolate } : {}),
```
`watch` and `attention` are explicitly deep-copied (including the nested `patterns` array), but `harness` and `isolate` are assigned the *same object reference* held by the live parsed config (`source.harness`/`source.isolate`), not a clone. The contract explicitly requires "Snapshot the parsed `AgentDef` before reservation" specifically so a later config change cannot retroactively alter an already-bound execution's effective definition. Whether this is practically exploitable depends on whether this codebase's config reload mutates existing `AgentDef` objects in place or always replaces the whole parsed tree with a fresh object graph — I did not find evidence either way within this review's audited paths (config loading/reload is outside `AgentManager.ts`/`tools.ts`), so I can't confirm live exploitability, but the inconsistency within the *same object literal* — two fields defensively cloned, two left as live references — is a real, inspectable gap against the contract's explicit snapshot requirement and is worth closing regardless of today's reload behavior.

## Hypothesis verdicts (recap)

1. **The one happy-path test does not implement the deterministic matrix; Bridge has no successful bound-execution mapping proof** — CONFIRMED, see H2. (Bridge-level tests only cover two *refusal* cases; there is no Bridge-level test that a successful `declared_agent` spawn actually reaches `AgentManager` with the right shape.)
2. **`spawned` becomes true only after `spawnCore` returns, but side effects occur inside it; a readiness failure can leave orphaned token/home footprint** — CONFIRMED, see H3.
3. **Harness retained by shallow reference; effective preflight runs twice** — the shallow-reference half is CONFIRMED (H4). The double-preflight-call half is real (once explicitly in `spawnDeliveryJoin`, once again unconditionally inside `spawnCore`) but I traced both calls through the only reachable production entry point (the `spawn_agent` Bridge tool, which does not expose `opts.env` for a `delivery_join` call) and found they always receive identical effective `cmd`/`env` inputs — so the duplication is redundant work, not a validation-bypass or reservation-before-validation ordering bug, given today's actual call surface.
4. **Authority/policy-first ordering; raw busy/version errors** — the collision checks (config/ad-hoc/ledger/**tmux**) and the reserved-env check all run before `prepareDeliveryJoin` (before any reservation), matching the contract's failure-order paragraph. `tmux.hasSession` (`TmuxService.ts:652-661`) checks for the existence of the tmux session object itself (via `has-session -t =<name>`), which — confirmed against this codebase's own existing dead-postmortem-vs-live handling in `spawnCore` (`AgentManager.ts:1130-1137`) — is true for both a live and a "dead"/postmortem session, so the "any live/dead tmux session" collision requirement is correctly covered. `TACHYON_AGENT_BRIDGE_TOKEN` on the source is explicitly refused; `TACHYON_AGENT_NAME` is not separately refused, but is unconditionally forced last in the actual env-merge (`AgentManager.ts:1216`, `TACHYON_AGENT_NAME: name` placed after `...def.env`), so it structurally cannot be overridden regardless — the asymmetric checking is correct, not a gap (the token *is* positioned earlier than `def.env` in that same merge and has no such structural protection, which is exactly why the contract singles it out for an explicit refusal).
5. **Config/ad-hoc/ledger/tmux collisions, reserved env, principal/cmd conflicts, unsafe reviewer command, failed preflight, harness/isolate inheritance, mint/materialization/hooks/cleanup, principal immutability, combined cleanup errors** — the *production code* for the collision matrix, reserved-token-env refusal, and field-exclusivity checks all look correct by inspection (see verdict 4), but essentially none of it is exercised by a test (see H2), and the cleanup/compensation paths have the real defect in H3.

## Confirmed correct (no finding)

- Field exclusivity (`cmd`/`principal` vs. `declared_agent`), source kind/existence, the four-way name-collision check, and the `TACHYON_AGENT_BRIDGE_TOKEN` reserved-env refusal all run before `prepareDeliveryJoin`, matching "before lease reservation."
- `principal` is set to `declared_agent` and `executionAgent` remains `name` in the request passed to `prepareDeliveryJoin`/`confirmDeliveryJoin`/`failDeliveryJoin` (`request = { ...request, principal: bound }`), matching the identity-normalization requirement.
- The reviewer-safety command transformation for the bound path is structurally identical to the pre-existing, already-accepted `cmd`-based join's handling (transform + advisory warning, hard rejection deferred to launch preflight) — not a new gap.
- Bridge wiring (`tools.ts`) correctly treats a `declared_agent` spawn as an AI delegation requiring the same structured contract as an ad-hoc AI child (`isBoundDeliveryExecution` folded into `isAdhocAiAgent`), and routes the brief through `appendInstructions` rather than replacing the declared role's own `instructions`, matching "append the Bridge-managed delegation contract after the declared role instructions."
- `spawnCore`'s `adhoc` flag correctly includes the new `ephemeral` case (`!!opts?.cmd || !!forced?.ephemeral`), so the bound execution is recorded/listed/cleaned as ad-hoc with `declared:false`, matching the contract.
- The commit is scoped to exactly the five owned paths; no Workspace/Delivery-store/SessionLedger-schema/config-schema/GitDelivery/continuity/tachyon.yml/task-store edit is present.

## Verification

- `npx vitest run test/unit/agentManager.test.ts test/unit/bridge.test.ts test/unit/deliveryBoundT13TerraBehavior.gen.test.ts --maxWorkers=1` (run in the candidate's own worktree, `/home/goat/.cache/tachyon/worktrees/b349073a/deliveryBoundT13Terra`, since `672ba2e0` is not an ancestor of `main`) — PASS (327 tests, 3 files: 269 AgentManager + 57 Bridge + 1 generated stub, matching the coordinator's reported counts).
- `git diff --check 221b3d9..672ba2e0` (same worktree) — PASS, no whitespace errors.
- `npm run typecheck` / `npm run verify:full` — not run per review contract.
- Review remained read-only for `src/` and `test/`; no fix was designed or implemented.

## Verdict

FINDINGS
