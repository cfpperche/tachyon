# 370 — Runtime launch preflight — tasks

_Implementation authorized after maintainer ratification on 2026-07-10._

## T0 — policy and empirical contract

- [x] Ratify unverifiable explicit-model policy, synchronous readiness behavior, and provisional timeout semantics.
- [x] Capture bounded `codex debug models` fixtures for supported, absent, malformed, timeout, non-zero, and oversized
  catalog results without committing raw base instructions or auth-related data.
- [x] Measure the exact environment difference between default Codex home and a prospective Tachyon private home.
- [x] Define which launch artifacts may exist before preflight and the compensation invariant for each.

## T1 — runtime preflight domain

- [x] Implement token-aware, non-executing runtime/model extraction with ambiguous-command degradation.
- [x] Implement closed preflight result/error types and runtime adapter registry.
- [x] Implement bounded Codex catalog probe using the exact binary/effective environment and exact slug matching.
- [x] Add deterministic suggestion-only close matches; prove no automatic command mutation.

## T2 — lifecycle integration

- [x] Integrate preflight at the shared AgentManager lifecycle boundary for spawn/autostart/restart/resume/fork.
- [x] Reorder persistence so rejected launches create no ledger/delegation/lineage/Bridge binding/onSpawned state.
- [x] Add explicit compensation for prepared worktrees, reservations, private homes, and tmux on rejection.
- [x] Add provisional startup readiness/error classification with bounded wait and honest pending behavior.
- [x] Return structured Bridge spawn outcomes; if ratified, reject Task assignment to non-ready agents.

## T3 — verification and dogfood

- [x] Unit-test exact `gpt-5.6` rejection against a catalog containing only Sol/Terra/Luna variants.
- [x] Unit-test `gpt-5.6-sol` acceptance without a static Tachyon model list.
- [x] Prove known-invalid and probe-failure paths leave no tmux, ledger, lineage, task notice, or worktree.
- [x] Prove all lifecycle entry points revalidate after catalog drift.
- [x] Dogfood invalid then valid Codex model launches with no task assignment between rejection and readiness.
- [x] Run full verification.
- [x] Inspect the Dev Host sidebar/terminal behavior through the maintainer-owned F5 dogfood.

## T4 — live dogfood recovery hardening

- [x] Resolve EDH executables from explicit/current/shared-checkout native caches and reject WSL remote CLI paths.
- [x] Sanitize inherited Tachyon/Codex/tmux identity and use in-memory secret storage for GUI and headless EDH.
- [x] Classify the measured Codex bootstrap prompts with closed answer grammars.
- [x] Permit only exact `answering=true` submitted-line/literal-key pairs while preserving all other readiness gates.
- [x] Prove arbitrary contracts, raw typing, mismatched answers, notifications, and Task assignment remain refused.
- [x] Run the persistent Bridge daemon in Node mode under native Electron and stop it before fixture removal.
- [x] Repeat deterministic and live EDH dogfood, retain bounded evidence, and clean all fixture-owned processes/files.

## Verification

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm run dogfood:runtime-launch-preflight`

The headless pilot uses bounded catalog fixtures and the EDH lane lease. It makes no live catalog or inference call;
the delegated GUI launch below remains coordinator-owned after product integration.

**Human dogfood:** Attempt a delegated launch with `gpt-5.6`, confirm a pre-tmux structured rejection and suggestions,
then launch the same contract with `gpt-5.6-sol` and assign the task only after readiness.

## Visual QA

- [x] Evidence: maintainer-owned Dev Host screenshot from 2026-07-17 at
  `/mnt/c/Users/cfpp/Pictures/Screenshots/Screenshot 2026-07-17 170657.png`; Runtime Ops reports four managed agents,
  three active agents, zero throttled runtimes, and zero Bridge issues after the invalid/valid launch sequence.
- [x] Verdict: maintainer confirmed every expected step occurred: the invalid Codex model failed closed, valid Codex,
  Claude, and Grok reached their expected states, and no ghost agent, stuck startup, error loop, or silent model
  substitution remained.
