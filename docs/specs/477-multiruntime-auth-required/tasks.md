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
- [x] Close that gap with a MEASURED signal rather than an inference (`t-0338fc`): `--format json` and
      an explicit `-m` pin ruled out by measurement, the credential store (`opencode providers list`)
      declared in `RUNTIME_AUTH_PREFLIGHT`, and consumed by `OpencodeLaunchPreflight` as a fail-closed
      launch refusal. Row 16 moves `✗` → `~`; the turn matcher stays absent.
- [x] Declare the per-runtime auth-required matcher (`src/runtime/authRequired.ts`), measured-or-absent,
      with the version it was measured on.
- [x] Add the auth-required agent STATE (attention/sidebar/protocol) fed only from a declared matcher
      (`t-5bfb72`): `AgentAttention.authRequired`, latched on a quiet pane only, surfaced as a sidebar
      badge, a warn toast and a parent notice.
- [x] Surface the human action at the launch boundary, naming runtime, agent and the safe action,
      with no credential material in the message.
- [x] Hold the assigned task and suppress automatic restart/retry while the state holds (`t-5bfb72`):
      restart policy forced to `never`, rate-limit auto-continue cancelled, assignment untouched.
- [x] Allow explicit restart/retry after a human login, preserving the assignment (`t-5bfb72`): the
      latch releases on the first real new-turn edge, which an unauthenticated runtime cannot produce.
- [x] Fixtures from the captured bytes for every implemented runtime, plus negative cases for rate
      limit, quota, permission, network and invalid session — and the Claude-footer false positive.
- [x] Real-runtime dogfood re-deriving every signal from credential-free homes, including OpenCode's
      silence (`npm run dogfood:auth-required-parity`). Extended by `t-0338fc` to drive the OpenCode
      gate BOTH ways against the real CLI — a credential-free home refused, the operator's own home
      admitted — because a preflight that only ever refuses is an outage, not a gate.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] A measured signal produces auth-required attention, not idle and not a generic crash.
- [x] No notification or stored state contains credential material.
- [x] The assigned task survives the episode un-executed, with no automatic retry.
- [x] Explicit retry after login runs, task still assigned.
- [x] Rate limit / quota / permission / network / invalid session do NOT become auth-required.
- [x] A runtime with no declared matcher never reports auth-required.

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm run dogfood:auth-required-parity`

**Human dogfood:** optional — with a runtime logged out, confirm the sidebar shows the agent as
needing a human and naming the action, and that its task is still assigned afterwards.

## Visual QA

**Visual QA:** the contract increment changed documentation only. The implementation increment
(`t-5bfb72`) adds the badge, so the proof belongs here: preview fixture `auth-required`
(`/scripts/webview-preview/index.html?view=sidebar&fixture=auth-required`), which deliberately puts a
genuinely idle row next to two held ones — the badge is the only thing that tells them apart.

## Cookbook

**Cookbook-Opt-Out:** no new operator surface — this changes what Tachyon reports about an agent, not
how anyone invokes anything.
