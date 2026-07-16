# 379 — delivery-lease-salvage — tasks

## Revised minimal cut

- [x] Fence-proof-or-bound-approval recovery branch with evidence level
- [x] Legacy-compatible, live-short-circuited `held → quarantined` entry
- [x] Approval-only worktree-free terminal disposition
- [x] Awaited kill-path `held → quarantined` CAS, never `free`
- [x] Domain-consistent fence evidence check with unavailable fallback
- [x] Workspace approval receipt and recovery-principal wiring
- [x] `delivery_salvage` Bridge surface and structured refusal hints
- [x] Flagship Case A/Case B canonical behavior verifier
- [x] Unit regression coverage for legacy boundaries, approval fallback, alive/ambiguous refusal, and evidence levels
- [ ] Installed dogfood against the retained real wedge (maintainer-owned after review)

## Verification

- [x] `npx vitest run test/unit/leaseSalvageBehavior.test.ts`
- [x] `npm run typecheck`
- [x] `npm run verify:full:quiet`
