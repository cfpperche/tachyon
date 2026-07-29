# 482 — unified-agent-instance — tasks

_Generated from `plan.md` on 2026-07-28._

**Ratified 2026-07-29** (`t-5e1113`, journal `j-f7fc20368177`). Implementation is authorised and
proceeds in verifiable slices, each landing green on its own tree.

## Gate

- [x] Measure the current code and record it with citations (`notes.md`).
- [x] Produce the ratifiable architecture (`spec.md`, `plan.md`).
- [x] Adversarial review by `claude-reviewer` — returned BLOCKER on two measured claims; both
      confirmed against the code and corrected (see `notes.md`, which keeps the errors visible).
- [x] Second adversarial pass on the corrected scope and the creation-door threat model — no new
      blocker; one residue of the first correction and two threat-model gaps, all three closed.
- [x] Present only the real decisions to the human and ratify — five approved, recorded in
      `spec.md` § Ratified decisions.
- [x] Decompose into verifiable slices (below).

## Slice 0 — symmetric durable lineage (ratified decision 5)

_First because it is small, self-contained, and the only ratified decision that changes measured
behaviour today. It also removes a strip that the fork work would otherwise have to reason around._

- [ ] `stripDeclaredParent` stops discarding a declared instance's parent.
- [ ] A Saved instance's parent survives a restart, exactly as a Temporary one's does.
- [ ] `declaredOwner` is untouched, and neither edge is derived from the other.
- [ ] Lineage is bounded by the INSTANCE: a new instance of the same profile does not inherit it.

## Phase 1 — converge fork onto the spawn implementation

_Replaces the first draft's "durable lineage" phase, which adversarial review showed was aimed at a
non-problem (`notes.md`)._

- [ ] `commitFork` stops building its own session; env merge, identity mint, session ownership and
      admission happen once, in the shared implementation.
- [ ] Equivalence proof before deleting the duplicate: same env, same minted identity, same admission,
      same ownership — and fork's transcript sharing and per-runtime refusals (Codex, Grok) intact.
- [ ] Forking a Saved agent stops forcing `declared: false`.

## Phase 2 — identity and lifetime as declared fields

- [ ] Add `identity` and `lifetime` to the instance record; keep `declared` as storage only.
- [ ] Refuse any inference of kind from command, name, tmux session, or `tachyon.yml` presence.

## Phase 3 — converge the readers

- [ ] Fleet, Activity, Attention, Execution Graph, worktree and cleanup branch on policy.
- [ ] Equivalence proof per reader before any duplicate is deleted.

## Phase 4 — the governed creation door (severable)

- [ ] Capability in the proposer's Profile; absence refuses by name.
- [ ] A committed agent never carries the creation capability — refused at commit, tested directly.
- [ ] Per-proposer pending ceiling; identical re-proposals collapse on digest instead of queueing.
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
