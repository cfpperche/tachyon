# 477 — multiruntime-auth-required — tasks

_Generated from `plan.md` on 2026-07-27. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Measure the unauthenticated signal for all six runtimes against credential-free private homes,
      and record the verbatim bytes in `spec.md`.
- [x] Record the two findings that constrain any detector: Claude's footer fires on healthy agents,
      and OpenCode emits nothing at all.
- [x] Expand `docs/runtimes/parity.md` with capability row 16 and §3.7 (mechanism, measured signal,
      official non-interactive refresh, human action, recovery) per the human's clarification.
- [x] File the OpenCode gap as its own task rather than inferring a signal (`t-0338fc`).
- [x] Declare the per-runtime auth-required matcher (`src/runtime/authRequired.ts`), measured-or-absent,
      with the version it was measured on.
- [ ] Add the auth-required agent STATE (attention/sidebar/protocol) fed only from a declared matcher — remaining scope, tracked as `t-5bfb72`.
- [x] Surface the human action at the launch boundary, naming runtime, agent and the safe action,
      with no credential material in the message.
- [ ] Hold the assigned task and suppress automatic restart/retry while the state holds — remaining scope, tracked as `t-5bfb72`.
- [ ] Allow explicit restart/retry after a human login, preserving the assignment — remaining scope, tracked as `t-5bfb72`.
- [x] Fixtures from the captured bytes for every implemented runtime, plus negative cases for rate
      limit, quota, permission, network and invalid session — and the Claude-footer false positive.
- [x] Real-runtime dogfood re-deriving every signal from credential-free homes, including OpenCode's
      silence (`npm run dogfood:auth-required-parity`).

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [ ] A measured signal produces auth-required attention, not idle and not a generic crash.
- [ ] No notification or stored state contains credential material.
- [ ] The assigned task survives the episode un-executed, with no automatic retry.
- [ ] Explicit retry after login runs, task still assigned.
- [ ] Rate limit / quota / permission / network / invalid session do NOT become auth-required.
- [ ] A runtime with no declared matcher never reports auth-required.

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm run dogfood:auth-required-parity`

**Human dogfood:** optional — with a runtime logged out, confirm the sidebar shows the agent as
needing a human and naming the action, and that its task is still assigned afterwards.

## Visual QA

**Visual QA Opt-Out:** the contract increment changes documentation only. The implementation
increment adds an attention state whose surface is the existing sidebar/attention rendering; visual
proof belongs with that increment.

## Cookbook

**Cookbook-Opt-Out:** no new operator surface — this changes what Tachyon reports about an agent, not
how anyone invokes anything.
