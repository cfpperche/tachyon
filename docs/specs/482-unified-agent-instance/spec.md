# 482 — unified-agent-instance

_Created 2026-07-28._

**Status:** draft — **ratification required before any implementation** (`t-5e1113`).

## Intent

Make Saved and Temporary agents one governed thing with two lifetime policies, and add a governed
door through which an agent may PROPOSE a Saved Agent without ever creating one.

The measurement (`notes.md`) shapes this, and two of its claims were **wrong in the first draft and
corrected after adversarial review** — the corrections are recorded there rather than quietly folded
in, because both errors deleted work:

> There is one door for *starting a named agent* (`AgentManager.spawn`), and a **second, parallel
> implementation in `commitFork`**, which builds its own session and re-does env merge, identity mint
> and admission. Converging them is real work. Separately, `declared: boolean` — a fact about *which
> store a definition came from* — is read as a fact about *what kind of worker this is*; `commitFork`
> hardcoding `declared: false` means forking a Saved agent yields a row stored as ad-hoc.

So this is: converge the spawn implementations (fork first, because it already diverges), split one
overloaded boolean into two declared fields, and put a locked door where agents currently have no door
at all.

## Acceptance criteria

_Observable outcomes. If every box can be ticked, the spec is delivered._

### A. The model

- [ ] **Scenario: identity and lifetime are separate declared fields**
  - **Given** any Agent Instance, Saved or Temporary
  - **When** the engine resolves it
  - **Then** `identity` (backed by a durable Profile, or not) and `lifetime` (restartable/resumable,
    or collected at end-of-work) are read from declared fields, and no code path infers either from
    the command, the name, the tmux session, or presence in `tachyon.yml`
- [ ] **Scenario: one instance record, one renderer**
  - **Given** a Fleet with both variants live
  - **When** the sidebar, Activity, Attention, Execution Graph and cleanup read them
  - **Then** each reads one Agent Instance shape and branches only on declared policy — no parallel
    store, no parallel renderer, no `declared ? … : …` standing in for a capability question

### B. Fork joins the unified path

_The first draft had a "durable lineage" section here. It was aimed at a non-problem: lineage is
durable for ad-hoc and deliberately stripped for declared (`notes.md`). This is what replaced it._

- [ ] **Scenario: a fork is an Agent Instance like any other**
  - **Given** a fork of a Saved or Temporary agent
  - **When** it starts
  - **Then** it goes through the same spawn implementation as every other instance — env merge,
    identity mint, session ownership and admission happen once, in one place, not in a parallel copy
- [ ] **Scenario: forking does not silently change what an agent IS**
  - **Given** a fork of a Saved agent
  - **When** the session row is written
  - **Then** its identity is not forced to ad-hoc as a side effect of storage — today `commitFork`
    hardcodes `declared: false`, which is invariant 5 being violated in production code
- [ ] Fork equivalence is proved before the duplicate is deleted: same env, same identity minting,
      same admission, same ownership, and the transcript-sharing behaviour fork exists for is intact.

### C. The governed creation door

- [ ] **Scenario: an agent with no capability cannot propose**
  - **Given** an agent whose Profile does not carry the creation capability
  - **When** it calls the proposal tool
  - **Then** it is refused by name, nothing is written, and absence of the capability is the refusal
    reason — never a default-allow
- [ ] **Scenario: a proposal is inert until a human ratifies THAT digest**
  - **Given** an agent that proposed a Saved Agent
  - **When** the proposal exists
  - **Then** no profile, authority or roster entry exists, no instance is launched, and the proposal
    is immutable and digest-bound
  - **And** approving one digest approves nothing else — a second proposal, an edited proposal, or an
    A2A message claiming approval are all refused
- [ ] **Scenario: the human sees what they are approving**
  - **Given** a pending proposal in the Human Inbox
  - **When** the human opens it
  - **Then** they see effective configuration, runtime/model, dangerous permissions, requested
    ownership, affected files/authorities and a diff — with no secrets in any of it
- [ ] **Scenario: commit is atomic or it did not happen**
  - **Given** an approved proposal
  - **When** the host commits it
  - **Then** profile + authority + roster land through the same canonical transaction Agent Studio
    uses — the journaled phase machine `intent → staged → profile-published → authority-published →
    locator-written → activated → committed`, with `compensating`/`degraded` and crash recovery on
    re-read (measured in `notes.md`) — and any failure leaves no partial state
  - **And** phase 4 adds no second write path to authority: it arrives at that entry point with an
    approved payload, it does not re-implement the commit
- [ ] **Scenario: saving is not starting**
  - **Given** a committed Saved Agent
  - **Then** nothing is running: launch is a separate action under its own policy
- [ ] **Scenario: nothing is inherited implicitly**
  - **Given** a proposer with permissions, MCP, skills, hooks, memory, credentials and ownership
  - **When** its proposal is committed
  - **Then** the new agent has only what the proposal explicitly requested and the human approved
- [ ] **Scenario: state moved under the proposal**
  - **Given** an approved proposal whose expected state no longer holds (the roster or an authority
    changed after it was written)
  - **When** the commit runs
  - **Then** it is refused on the CAS/expected-state check rather than applied to a world it was not
    reviewed against
- [ ] A receipt links proposer, approver, digest, transaction/operation id and outcome.
- [ ] Revocation, expiry, cancellation, idempotent retry and post-restart behaviour are each defined
      and tested — a pending proposal that survives a restart must not become approvable by accident.

### D. Compatibility

- [ ] `spawn_agent`'s public contract is unchanged for the whole migration.
- [ ] Agent Studio, restart, resume and fork keep working, and each names whether it acts on Profile,
      Instance or Runtime Session.
- [ ] `subagents`/`declaredOwner` (Profile→Profile ownership, no operational authority) and runtime
      `parent` (Instance→Instance lineage) stay distinct, and neither is derived from the other.
- [ ] Duplicate mechanisms are removed only after an equivalence proof, never in the same slice that
      introduces their replacement.
- [ ] Tachyon still works with no SDD/ADR plugin present, and the wire protocol is not widened without
      a version bump and cross-version proof.

## Invariants

These are the properties a reviewer should try to break. They are stated as refusals because each one
has a known way to fail open.

1. **Absence of capability is refusal.** Never a default, never inherited from a parent, never implied
   by an agent already having spawned Temporary children.
2. **An agent never writes durable identity.** It writes a proposal. Profile, authority and roster are
   written by the host, through the canonical transaction, after human approval of that digest.
3. **Approval is bound to a digest, not to a proposer, a session, or a conversation.**
4. **Saving is not starting.** No approval path may launch.
5. **Storage is not identity.** Which store a definition came from must not answer what kind of worker
   it is, or this design has failed and rebuilt the thing it removed.
6. **Ownership is not lineage.** `declaredOwner` grants no operational authority; `parent` confers no
   configuration.
7. **Probe is not an Agent.** No probe gains identity, task, continuity, worktree or Fleet presence.
8. **A Temporary agent is governed, not unmanaged.** "Temporary" bounds lifetime, never oversight.

## Minimal threat model — the creation door

| Threat | Failure mode | Control |
|---|---|---|
| Compromised or confused agent creates a privileged agent | Privilege escalation via a new principal | Capability required; proposal inert; human approves the digest; no implicit inheritance |
| Proposal mutated between review and commit | Human approves A, B is committed | Immutable, digest-bound proposal; digest re-verified at commit |
| World changes between review and commit | Approved against a roster/authority that no longer exists | Expected-state/CAS check at commit; refuse rather than apply |
| A2A message forges approval | Approval simulated by an agent | Approval is a host-side human action; agent-authored input can never carry it |
| Replay of an old approval | A revoked or expired proposal is committed later | Single-use digest, expiry, revocation, idempotent retry keyed on the digest |
| Secret exfiltration through the review surface | Credentials rendered into the Inbox or the receipt | Diff and summary are content-free of secrets by construction, like the existing config surfaces |
| Partial commit | An authority exists with no profile, or a roster entry with no authority | One atomic transaction; compensate on failure |
| Approval fatigue | Human rubber-stamps because the diff is unreadable | The Inbox shows effective configuration and dangerous permissions explicitly, not raw YAML |

## Non-goals

- Unifying Probe and Agent, or turning terminals/processes into agents.
- Making every instance persistent, or storing credentials/transcripts/caches/private homes in a Profile.
- A generic template language, or rewriting all runtime adapters at once.
- Changing public Bridge contracts in phase 1.
- Full long-tail runtime parity as a precondition for the architecture.

## Alternatives considered and discarded

- **Build a new unified spawn port.** Discarded by measurement: `AgentManager.spawn` already is one.
  Building a second "unified" port would add the duplication this task exists to remove.
- **Keep `declared: boolean` and layer policy on top.** Discarded: it is precisely the overloaded field
  that makes storage answer an identity question, and every future capability question would fork on
  it again.
- **Let a capable agent write the profile directly and audit afterwards.** Discarded: it makes the
  agent the writer of durable authority, so every later control becomes detection rather than
  prevention, and a receipt cannot un-create a privileged agent.
- **Approve a proposer once, then let it create freely.** Discarded: approval would attach to a
  principal instead of to what is being created, which is the one thing the human is actually judging.
- **Rename first, migrate later.** Discarded: renaming is the only part with no behavioural risk and no
  behavioural value; doing it first spends the migration's credibility on churn.
- **Big-bang unification.** Discarded by the repository's own history — the abandoned migration/rollback
  track in the project handoff is what that costs.

## Open questions for the human

Only decisions that are genuinely open — everything else is settled by measurement above.

1. **Does the creation door ship at all in v1?** It is the largest new surface and the only part that
   adds risk rather than removing it. The model unification stands on its own without it.
2. **Should a Temporary agent be promotable to Saved through the same proposal door?** Same review
   surface, or a distinct one because the configuration already ran.
3. **Lifetime policy vocabulary in the product**: `Saved Agent` / `Temporary Agent` are proposed. They
   are user-visible and hard to change later.
4. **How long does a pending proposal live** before it expires, and does a restart preserve or void it?
5. **Does lineage stay asymmetric?** Today a Temporary agent's parent survives a restart and a Saved
   agent's is deliberately dropped. That is a real product choice, not a bug — but a unified Agent
   Instance either keeps the asymmetry deliberately or resolves it, and the code cannot say which.
