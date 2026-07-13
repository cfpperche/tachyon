# 370 — Runtime launch preflight — tasks

_Implementation authorized after maintainer ratification on 2026-07-10._

## T0 — policy and empirical contract

- [x] Ratify unverifiable explicit-model policy, synchronous readiness behavior, and provisional timeout semantics.
- [ ] Capture bounded `codex debug models` fixtures for supported, absent, malformed, timeout, non-zero, and oversized
  catalog results without committing raw base instructions or auth-related data.
- [ ] Measure the exact environment difference between default Codex home and a prospective Tachyon private home.
- [ ] Define which launch artifacts may exist before preflight and the compensation invariant for each.

## T1 — runtime preflight domain

- [ ] Implement token-aware, non-executing runtime/model extraction with ambiguous-command degradation.
- [ ] Implement closed preflight result/error types and runtime adapter registry.
- [ ] Implement bounded Codex catalog probe using the exact binary/effective environment and exact slug matching.
- [ ] Add deterministic suggestion-only close matches; prove no automatic command mutation.

## T2 — lifecycle integration

- [ ] Integrate preflight at the shared AgentManager lifecycle boundary for spawn/autostart/restart/resume/fork.
- [ ] Reorder persistence so rejected launches create no ledger/delegation/lineage/Bridge binding/onSpawned state.
- [ ] Add explicit compensation for prepared worktrees, reservations, private homes, and tmux on rejection.
- [ ] Add provisional startup readiness/error classification with bounded wait and honest pending behavior.
- [ ] Return structured Bridge spawn outcomes; if ratified, reject Task assignment to non-ready agents.

## T3 — verification and dogfood

- [ ] Unit-test exact `gpt-5.6` rejection against a catalog containing only Sol/Terra/Luna variants.
- [ ] Unit-test `gpt-5.6-sol` acceptance without a static Tachyon model list.
- [ ] Prove known-invalid and probe-failure paths leave no tmux, ledger, lineage, task notice, or worktree.
- [ ] Prove all lifecycle entry points revalidate after catalog drift.
- [ ] Dogfood invalid then valid Codex model launches with no task assignment between rejection and readiness.
- [ ] Run full verification and inspect the installed sidebar/terminal behavior.

## Verification

**Verify:** `npm run verify:full`

## Dogfood

**Dogfood:** `npm run dogfood:runtime-launch-preflight`

The headless pilot uses bounded catalog fixtures and the EDH lane lease. It makes no live catalog or inference call;
the delegated GUI launch below remains coordinator-owned after product integration.

**Human dogfood:** Attempt a delegated launch with `gpt-5.6`, confirm a pre-tmux structured rejection and suggestions,
then launch the same contract with `gpt-5.6-sol` and assign the task only after readiness.

## Visual QA

- [ ] Evidence: invalid launch produces no live agent row; valid launch shows the normal row; optional starting state is
  visually distinct and cannot receive a Task if that policy ships.
- [ ] Verdict: no ghost agent, false running state, error loop, or silent model substitution.
