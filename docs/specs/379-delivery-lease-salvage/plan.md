# 379 — delivery-lease-salvage — plan

_Revised 2026-07-16 after adversarial review. Supersedes the original draining/salvaged-state design._

Affected Product Invariants: none — PI-001 concerns project-guidance ownership, not Delivery recovery.

## Approach

Use the existing `quarantined → pending|abandoned` recovery machinery. Do not add a lease state, approval system, or observer.

1. Recovery accepts domain-stable `proven_empty` fence evidence OR an exact bound human approval and records `fence-proof` or `approval-only`.
2. A coordinator-only held entry uses the legacy-compatible boundary (`executionNonce` plus holder segment matching the open tail), refuses alive/ambiguous roots, and CASes `held → quarantined`.
3. Worktree-free abandonment CASes the frozen lease and tail under bound approval, performs no worktree reads, and records only `approval-only`.
4. The awaited Workspace kill callback CASes matching `held → quarantined` before `kill_agent` returns; termination never yields `free`.
5. Fence proof is trusted only when capability domains match before and after proof; unavailable/inconsistent evidence falls back to approval.
6. Workspace resolves caller-scoped human approvals and supplies configured coordinator principals.
7. Bridge exposes `delivery_salvage` with Bridge-resolved actors and refusal hints point dead-ended callers to it.

## Security decisions

- Fence is evidence; approval is authority for unprovable recovery.
- Holder, holder principal, tail execution agent, and tail principal cannot authorize their own recovery.
- Every transition freezes lease plus open tail and rechecks them at the store CAS.
- Case A retains the existing two inventory reads. Case B is honest about having no worktree evidence.
- Principal equality is not required when a legacy holder omitted principal; an explicit holder principal must still match.

## Verification

The fixed task verifier is `npx vitest run test/unit/leaseSalvageBehavior.test.ts`, followed by `npm run typecheck` and `npm run verify:full:quiet`.
