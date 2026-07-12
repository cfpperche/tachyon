# SDD 368 T14.6B2 mechanism-only delivery joins — Grok final R2 binary review — ACCEPT

Reviewed immutable range
`0a62e50e7afe0646d13b16ca52903b7cf3f491fc..41a64ebb7a048ac445214446e42ab8d498ebf174`
(three commits: `3bbe002b` initial B2, `46ea829a` R2 safety close, `41a64ebb` R3 lifecycle
acceptance) in worktree
`/home/goat/.cache/tachyon/worktrees/b349073a/deliveryMechanismB2TerraR1` against final binary
contract `j-a8697dbbdcd1` (task `t-0b5723`).

Canonical `verify_task` **ACCEPT** with one historical exact-path waiver at
`.tachyon/verifications/41a64ebb7a048ac445214446e42ab8d498ebf174.json` (waiver is coordinator
omission of the original generated stub from an intermediate R2 reuse subset — not authority
widening). Independent dogfood rerun: `node scripts/dogfood/delivery-lease.mjs` → **passed**
(executes `workspaceHeadless` title
`mechanism-only canonical Delivery reuses one worktree through review completion`).

Production and tests read-only; only this artifact is written. Binary rule per contract: **FINDINGS
only for a concrete reproducible correctness/security/safety defect** — not matrix gaps, style, or
hardening wish-lists when production is sound.

## R1 reconciliation (`.tachyon/reviews/368-mechanism-b2-r1.md`)

| R1 | Claim | Production status at `41a64ebb` |
|----|--------|----------------------------------|
| F1 HIGH | `isAncestor`/inspections ignore git exit codes | **Closed.** `requiredGitOutput` / `requiredGitStatus` require `code===0` and SHA-1/SHA-256 hex shape; status failure never means clean; `isAncestor` is `0→true`, `1→false`, other→throw (`Workspace.ts` ~2265–2285, 480–485). |
| F2 HIGH | Forcing title only parses config; dogfood prints readiness | **Closed.** Title lives in `workspaceHeadless.test.ts` as real `Workspace.createForTest` + `AgentManager` gated implementer → deliveryJoin reviewer → `completeReview` FINDINGS → fixer join → reviewer-2 join → ACCEPT; asserts single projection, single base worktree dir, free lease, segment roles. Dogfood spawns that vitest and fails on nonzero status. |
| F3 MEDIUM | Stopper never re-reads live pane PID | **Closed.** `exactExecutionStopper` reads `tmux.panePid(session(executionAgent))` and requires equality to `input.process.pid` plus start/boot before `manager.kill` (~493–504). Replacement-PID headless test forces refuse/quarantine with replacement child left alive. |
| F4 MEDIUM | `handoffSafety` frozen from earlyConfig | **Closed.** Service takes `handoffSafety: () => this.effectiveDeliverySafety()`; effective safety is live `this.config` and non-canonical ⇒ disabled (~469, 2388–2391). |
| F5 MEDIUM | Linked projection ignores `gitDeliveryId` / missing realpath | **Closed.** Shared `exactCanonicalProjection` requires backlink, exactly one linked row, `id===gitDeliveryId`, existing realpath; prepare, `canonicalWorktreeFor`, and Bridge complete-review use that authority + `realpathSync` (~2285–2290, 2398–2399, tools ~2565–2569). |
| F6 MEDIUM | Nonce/process bind gaps / disabled compatibility | **Closed enough.** Disabled canonical create skips `/proc`/nonce; non-disabled requires exact identity at create and refuses reverse-bind without nonce+process (~2316–2322, 2380–2383). |
| F7 MEDIUM | Bridge complete-review auth thin/untested | **Closed for production.** Creator/human/master gate before service; refuse missing/legacy/external/unrelated; backlink+id+realpath; mechanism-only warning only via live `deliverySafety()`; SHA-1/64 schema. Bridge unit coverage exercises creator success, reviewer refuse, zero `completeReview` on deny, and malformed SHA. |
| F8 | failJoin / compensation | **Production path sound.** Nonce-scoped pending/held quarantine; join catch cleans then `failJoin`. No concrete production defect found in the algorithm. |

Coordinator join-auth HIGH (spawn `delivery_join` without creator/store): **Closed** — store required, resolved human/master/exact creator agent required **before** `manager.spawn` (tools ~1057–1065).

## Invariant audit (binary)

- **Git fail-closed:** exit codes and empty/malformed object ids refuse; diverged ancestry no longer always-true.
- **Live safety:** getter + `effectiveDeliverySafety`; reload mutates `this.config` so subsequent lease ops see new safety; non-canonical forces disabled.
- **Disabled vs sequential create:** disabled avoids `/proc`/nonce; mechanism-only/process-fenced require them before bind.
- **Canonical resolver:** backlink + single exact row + realpath at prepare/service/Bridge.
- **Exact stopper:** holder + ledger + cwd/worktree realpaths + live pane PID + start/boot; replacement PID survives refusal (tested).
- **Bridge join/review authority:** fail closed without store/caller; only privileged/creator; review uses realpath + backlink; warning only for mechanism-only.
- **failJoin:** pending `reservationNonce` or held `executionNonce` match only; names are not authority.
- **One-worktree lifecycle:** Workspace/AgentManager path + dogfood execute the forcing title; no second base worktree directory in that test.
- **Boundaries:** strong fence remains `UnavailableProcessFence`; no recovery/salvage/integrate authority added in this delta.

## Explicit non-findings (not blocking)

- Dedicated `failJoin` table tests are thin/absent relative to R3-5 wording; production algorithm is correct and binary contract forbids blocking solely for matrix residual when production is sound.
- Lifecycle test asserts one base worktree directory and reviewer cwd realpath identity; it does not re-assert every intermediate ledger path (hardening, not a production defect).
- Generated service-mock file remains a secondary semantic suite under a different title; dogfood and canonical behavior title bind the real Workspace path.

## Verification performed

- Full production call-path read of `Workspace` lease adapters/stopper/create/join, `leaseService.failJoin` + absence, Bridge `delivery_join` / `delivery_complete_review`.
- Independent `node scripts/dogfood/delivery-lease.mjs` green at HEAD.
- Independent vitest of replacement-PID quarantine case green.
- Confirmed verification record ACCEPT + waiver scope as stated in contract.

## Verdict

**ACCEPT.**

No concrete reproducible correctness, security, or safety defect remains in production for the T14.6B2 scope at `41a64ebb`. R1 F1–F8 and the coordinator join-auth gap are closed in production. Residual test-matrix breadth is outside the binary blocking rule.
