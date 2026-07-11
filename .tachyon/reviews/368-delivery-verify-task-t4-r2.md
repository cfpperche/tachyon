# SDD 368 T4 adversarial review round 2 — `7b116b9`

**Verdict: FINDINGS**

## Scope

Delta review of `ecbd422..7b116b9` (`fix(t-0b5723): bind verify_task to the canonical delivery occupant`),
which was written specifically to close prior review [`5b4dbd1`](368-delivery-verify-task-t4-r1.md)'s F1
(canonical `delivery_id` bypassed the self-waiver check), F2 (adapter assigned operational identity to
segment zero instead of the current occupant), and F3 (verification artifact not bound to `delivery_id` /
segment identity). This round re-examines those three closures for completeness against the surrounding
code the closures did not touch, and checks: authorization/waiver semantics, canonical current-occupant
selection, ambiguous legacy sugar, artifact identity/path/hash collision resistance, backwards
compatibility, and test truthfulness. Read-only review; no production or test files were modified. No test
suite was executed (host memory pressure — instructed to avoid `npm run verify:full`); findings below are
established by static tracing of the actual call chains (`resolveVerificationTarget` →
`assertWaiverAuthorized` / `occupant` uses; `deliveryToVerificationRecord` → `resolveOperationalSegment`;
`DeliveryStore.assertSegmentMutation`; `AgentManager.spawnReuseWorktree` → `appendFixerAttempt`), not by
running new tests.

## Confirmed closures (from r1)

- **F1** (delivery_id bypassing self-waiver check) — closed for the two-occupant case. `assertWaiverAuthorized`
  (`src/bridge/verifyTask.ts:195-207`) now runs *after* resolution and compares the Bridge-resolved caller
  against both `identity.canonical` and `identity.legacy`, for both the `delivery_id` and legacy-`agent`
  paths. A caller can no longer dodge the guard by naming someone else in `agent` or by routing through
  `delivery_id` (`test/unit/verifyTask.test.ts`, "refuses a self-waiver even when the caller spoofs `agent`
  or routes around it with `delivery_id`").
- **F2** (segment-zero misuse) — closed for the direct Delivery adapter. `resolveOperationalSegment`
  (`src/delivery/verifyAdapter.ts:52-95`) derives the tail segment and re-proves contiguity, id uniqueness,
  single-open-tail, and lease-holder agreement, failing closed (`DeliveryIdentityError`) rather than
  guessing on an ambiguous chain.
- **F3** (artifact binding) — closed. `VerifyTaskRecord.identity` is part of the hashed body
  (`recordWithHash`, `verifyTask.ts:476-479`), delivery-backed records get a `(deliveryId, segmentId)`-scoped
  path (`verificationRecordPath`, `verifyTask.ts:500-506`), and a scope-mismatched write at an existing path
  is refused (`VERIFICATION_RECORD_CONFLICT`, `verifyTask.ts:508-531`).

Both closures generalize to a **"two occupants: `legacy` (first) + `canonical` (tail)"** model. That model
is incomplete for two data shapes the surrounding code already builds and already scope-checks — see G1/G2.

## G1 — HIGH — legacy `DelegationRecord` fixer rounds (`reuse_worktree`) are invisible to both the F1 waiver guard and the F2 occupant-liveness fix

Evidence: `resolveVerificationTarget`'s legacy branch (`src/bridge/verifyTask.ts:173-181`) hardcodes:

```ts
// A legacy DelegationRecord has no segment chain: its operational occupant has always been `agent`, and
// that stays true here (fixerAttempts work inside the same delegation, under the same name). Legacy and
// canonical coincide, so this path behaves exactly as it did before Delivery existed.
const record = matches[0]!.record;
return {
  record,
  identity: { legacy: record.agent, canonical: record.agent, ...(record.id ? { delegationId: record.id } : {}) },
};
```

The premise ("under the same name") is false. `reuse_worktree` (t-815796) is a fully live mechanism, not a
pre-Delivery artifact: `spawn_agent`'s `reuse_worktree` input (`src/bridge/tools.ts:763-778`) is dispatched
to `AgentManager.spawnReuseWorktree` (`src/agents/AgentManager.ts:779`), which grants a **new agent name**
(the spawn's own `name` argument) an existing delegation's worktree and calls `appendFixerAttempt`
(`src/agents/AgentManager.ts:848` → `src/bridge/delegationRecord.ts:145-149`). `appendFixerAttempt` records
the new agent as `fixerAttempts[].occupantAgent` and — critically — never rewrites `record.agent`, which
stays the *original* delegate's name for the life of the record. So for any legacy delegation with one or
more `reuse_worktree` rounds, `identity.canonical` names the original agent, never the agent that currently
(or most recently) held the worktree.

This reopens both closed bug classes on this one path:

1. **F1 reopened.** `assertWaiverAuthorized` only refuses a caller matching `identity.canonical` /
   `identity.legacy` — both `record.agent`, the original name. A fixer's Bridge-resolved identity is neither
   (it's an unrelated agent name), so it can call `verify_task({ agent: "<original-name>", waivers: [...] })`
   as itself — `agent` *must* stay the original name regardless, since that's the key
   `findNonArchivedDelegationRecordsByAgent` (`verifyTask.ts:161`) looks the record up by — and self-waive
   findings on code it alone authored, with the guard never firing. This isn't the "spoof `agent`" trick F1
   closed; it's an honest call from the fixer's own resolved caller identity that the guard simply never
   checks against.
2. **F2 reopened.** `occupant = identity.canonical` (`verifyTask.ts:653`) drives `isAgentRunning(occupant)`
   and `withWorktreeLock(occupant, ...)` (`verifyTask.ts:685-690`, `isAgentRunning` wired in
   `src/bridge/tools.ts` as `deps.manager.agentStates().get(name)`) and the doorbell check
   (`verifyTask.ts:755`). All three check the *original* agent's liveness/attribution, never the fixer's. In
   the normal `reuse_worktree` flow the original agent has already exited (that's why the worktree was
   handed off), so `isAgentRunning("<original>")` returns false even while the fixer is genuinely still
   live and editing the shared worktree — `agent_still_running` never fires, and `runAtSha`
   (`git checkout --detach --force` / `reset --hard` / `clean -fd`) force-mutates the worktree out from
   under the live fixer. This is the exact hazard F2 was written to close, reproduced on this path.

Required closure: for the legacy branch, derive `identity.canonical` from the **last**
`fixerAttempts[].occupantAgent` when `fixerAttempts` is non-empty, falling back to `record.agent` only when
it's empty — mirroring what `deliveryToVerificationRecord` already does for Delivery segments. Add a test
that grants a `reuse_worktree` round to a different agent name and proves: (a) that fixer cannot self-waive,
(b) `isAgentRunning`/`withWorktreeLock` are invoked with the fixer's name, not the original's.

## G2 — MEDIUM — the waiver guard recognizes only the first and last Delivery occupant; an interior segment can self-waive its own work

Evidence: `assertWaiverAuthorized` (`src/bridge/verifyTask.ts:200-201`) is a two-name check:

```ts
if (caller.name !== identity.canonical && caller.name !== identity.legacy) return;
```

`identity.legacy` is always segment 0 and `identity.canonical` is always the tail
(`src/delivery/verifyAdapter.ts:118-138`). A Delivery is not capped at two segments:
`DeliveryStore.assertSegmentMutation`/`validateRecord` (`src/delivery/store.ts:513-565`) explicitly support
appending one segment per mutation with no upper bound, `DelegationSegmentRole` includes `fixer`/`recovery`
precisely for multi-round rework, and `scopeBreachBlockers` (`verifyTask.ts`) already scope-checks each
interior fixer round's own commits against that round's own `ownsSubset`. For a 3-segment chain
`[worker (closed), fixer-1 (closed), fixer-2 (tail)]`, `identity = { legacy: "worker", canonical: "fixer-2" }`
— `fixer-1` is neither, so `fixer-1` can call
`verify_task({ delivery_id, waivers: [...] }, verifierCaller: { kind: "agent", name: "fixer-1" })` and waive
a finding (e.g. a suppression tripwire) tied to commits only it authored, undetected.

Reachability note (to keep this honest): this snapshot's Bridge surface does not expose an obvious tool
that grants an *additional* Delivery segment post-creation (the `reuse_worktree`/`appendFixerAttempt` path
found for G1 operates on legacy `DelegationRecord`s, not `Delivery`). The store-level invariant machinery is
nonetheless already built and tested to allow it, and the verifier's own scope-check logic already assumes
and handles N-segment chains — so this is a real gap in the identity model, one likely to become live the
moment the segment-granting side of the canonical Delivery path (T9 or adjacent) ships, rather than a
theoretical one.

Required closure: track every occupant a Delivery has ever had (`segments[].executionAgent`, not just
first/last) in `VerifyTaskIdentity`, and reject a waiver from any of them — or, more precisely, from any
occupant whose own commits are in the scope of what's being waived. Add a 3-segment test mirroring the
existing 2-segment "refuses a self-waiver…" test.

## Confirmed behavior (unaffected by this delta, re-checked for regression)

- Ambiguous legacy sugar (same-name, multiple non-archived `DelegationRecord`s) still refuses deterministically
  via `AMBIGUOUS_LEGACY_DELEGATION`, unchanged from r1 and independent of mtime (`deliveryVerifyTaskT4Behavior.gen.test.ts`).
- The verification-record integrity hash covers the full record including the new `identity` field, so a
  hash cannot be forged by editing `identity` alone.
- The `(deliveryId, segmentId)` path-scoping hash truncation (64 bits) is not a security boundary by itself
  — the `VERIFICATION_RECORD_CONFLICT` scope-key check (which compares full, untruncated identity fields)
  fails safe even in the astronomically unlikely event of a truncated-hash path collision.
- `record.agent`/`record.owns`/`record.baseSha` etc. (the contract fields the scope checker binds to) are
  correctly left sourced from the *original* occupant/`delivery.contract` throughout — only the
  operationally-relevant identity (`occupant` = `identity.canonical`) was redirected to the tail, which is
  the correct split.

## Gate assessment

r1's F1–F3 are closed for the two-occupant, Delivery-only case the new tests exercise. G1 is reachable
*today*, with no other precondition, through the live `reuse_worktree` tool, and reopens both F1's
self-waiver bypass and F2's wrong-occupant-liveness hazard on that path — this alone is sufficient to
withhold acceptance. G2 requires a 3+ segment Delivery; the data model already fully supports it even though
this snapshot doesn't yet expose a Bridge tool that grants segment 3+. Recommend against accepting T4 until
at least G1 is closed; G2 should be closed before (or fail closed until) canonical multi-round segment
granting ships.

## Focused commands run

```
git log --oneline -5
git log --oneline ecbd422..7b116b9
git show 5b4dbd1:.tachyon/reviews/368-delivery-verify-task-t4-r1.md
git log --oneline --graph --all -30
git diff ecbd422..7b116b9 -- src/bridge/tools.ts src/bridge/verifyTask.ts src/delivery/verifyAdapter.ts \
  test/unit/deliveryVerifyTaskT4Behavior.gen.test.ts test/unit/verifyTask.test.ts
git show 7b116b9:src/delivery/verifyAdapter.ts
git show 7b116b9:src/delivery/types.ts
git show 7b116b9:src/bridge/verifyTask.ts
git show 7b116b9:src/bridge/tools.ts   # verify_task registration, ~L1005-1075
git show 7b116b9:src/bridge/delegationRecord.ts
git show 7b116b9:src/delivery/store.ts # assertSegmentMutation / validateRecord, ~L502-566
git grep -n "reuseWorktree|appendFixerAttempt" 7b116b9 -- src/
git grep -n "VerifyTaskResolutionError|VerifyTaskStructuredError|..." 7b116b9 -- src/ test/
git show 7b116b9:test/unit/deliveryVerifyTaskT4Behavior.gen.test.ts
```

No test suite was run (host memory pressure per task constraints); no production or test files were
modified by this review.
