# 482 — unified-agent-instance — tasks

_Generated from `plan.md` on 2026-07-28._

**Implementation is blocked until the human ratifies `spec.md` (`t-5e1113`).** Nothing below is
started; the boxes exist so the decomposition is reviewable alongside the architecture.

## Gate

- [x] Measure the current code and record it with citations (`notes.md`).
- [x] Produce the ratifiable architecture (`spec.md`, `plan.md`).
- [ ] Adversarial review by `claude-reviewer`.
- [ ] Present only the real decisions to the human (`spec.md` § Open questions) and ratify.
- [ ] Decompose into verifiable slices, each in an isolated worktree/Delivery.

## Phase 1 — durable lineage (the measured defect)

- [ ] Persist the parent edge with the identity it belongs to; a Saved agent's parent stays stripped.
- [ ] Prove it across an engine restart, including the gated-delegation case that has a `delegator`
      and deliberately no runtime `parent`.

## Phase 2 — identity and lifetime as declared fields

- [ ] Add `identity` and `lifetime` to the instance record; keep `declared` as storage only.
- [ ] Refuse any inference of kind from command, name, tmux session, or `tachyon.yml` presence.

## Phase 3 — converge the readers

- [ ] Fleet, Activity, Attention, Execution Graph, worktree and cleanup branch on policy.
- [ ] Equivalence proof per reader before any duplicate is deleted.

## Phase 4 — the governed creation door (severable)

- [ ] Capability in the proposer's Profile; absence refuses by name.
- [ ] Typed, immutable, digest-bound proposal; agent writes nothing durable.
- [ ] Host validation through the Agent Studio schemas/projections/policies/transaction.
- [ ] Human Inbox review: effective config, runtime/model, dangerous permissions, requested ownership,
      affected files/authorities, diff without secrets.
- [ ] Approval bound to the digest; A2A cannot simulate it.
- [ ] Atomic commit of profile + authority + roster; compensation on failure.
- [ ] Receipt: proposer, approver, digest, transaction/operation id, outcome.
- [ ] Revocation, expiry, cancellation, idempotent retry, post-restart behaviour.
- [ ] Saving does not start the agent.

## Phase 5 — terminology and removal

- [ ] `Saved Agent` / `Temporary Agent` / `Probe` with compatibility aliases.
- [ ] Remove duplicate mechanisms only against the equivalence proofs from phase 3.

## Verification

- [ ] Each phase green under `npm run verify:full:quiet` on the tree it delivers.
- [ ] Every threat-model control has a test that fails without the control.
- [ ] No regression for Claude, Codex and Grok first; OpenCode/Pi/Hermes secondary.

**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood-Opt-Out:** architecture only; nothing executable ships until a ratified slice does.

## Visual QA

**Visual QA Opt-Out:** no surface changes in this deliverable. Phase 4's Human Inbox review surface
needs it when that phase is authored, and agents do not open a Dev Host here (`t-ce83a2`).

## Cookbook

**Cookbook-Opt-Out:** no operator surface ships in this deliverable. Phase 4 adds a proposal/approval
flow and should carry one when authored.
