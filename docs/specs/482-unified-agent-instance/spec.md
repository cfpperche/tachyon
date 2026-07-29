# 482 — unified-agent-instance

_Created 2026-07-28._

**Status:** in-progress — **ratified by the human on 2026-07-29** (`t-5e1113`, journal
`j-f7fc20368177`). Decomposition and incremental implementation are authorised against this document.

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
- [ ] **Scenario: an approved creation cannot create**
  - **Given** a Saved Agent that was itself committed from an approved proposal
  - **When** it attempts to propose another Saved Agent
  - **Then** it is refused, because a created agent never carries the creation capability — one human
    approval must not become a tree of creators
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
9. **A created agent never creates.** An agent committed through the door never carries the creation
   capability, so one human approval can never become a tree of creators. Refused at commit, not
   filtered in the UI.

## Minimal threat model — the creation door

**Baseline first, because it decides how this section should be read.** Measured 2026-07-29: no Bridge
tool reaches canonical profile creation — `commitAgentProfileLifecycle`, `createProfileFromStudioMutation`
and `importAgentProfileBundle` have no caller anywhere under `src/bridge/`. An agent today can start a
Temporary agent (`spawn_agent`) and **cannot create a Saved Agent at all.**

So phase 4 does not harden a badly-guarded door. It **opens a door that is currently shut**, and moves
the state from *impossible* to *possible with human approval per creation*. Every row below is a control
on new authority, not a repair of existing authority. A human should ratify it on those terms; if the
answer is "the door stays shut", nothing else in this SDD is affected — which is what severability means
here.

| Threat | Failure mode | Control |
|---|---|---|
| Compromised or confused agent creates a privileged agent | Privilege escalation via a new principal | Capability required; proposal inert; human approves the digest; no implicit inheritance |
| Proposal mutated between review and commit | Human approves A, B is committed | Immutable, digest-bound proposal; digest re-verified at commit |
| World changes between review and commit | Approved against a roster/authority that no longer exists | Expected-state/CAS check at commit; refuse rather than apply |
| A2A message forges approval | Approval simulated by an agent | Approval is a host-side human action; agent-authored input can never carry it |
| Replay of an old approval | A revoked or expired proposal is committed later | Single-use digest, expiry, revocation, idempotent retry keyed on the digest |
| Secret exfiltration through the review surface | Credentials rendered into the Inbox or the receipt | Diff and summary are content-free of secrets by construction, like the existing config surfaces |
| Partial commit | An authority exists with no profile, or a roster entry with no authority | One atomic transaction; compensate on failure |
| **Capability recursion** | One approval becomes a tree of creators: an agent created by proposal carries the propose capability and creates further agents, turning a per-creation control into a per-principal one — the alternative this design explicitly rejected | A created agent **never** carries the creation capability. It is refused at commit, not filtered in the UI, so a proposal that requests it fails rather than arriving quietly stripped. Granting it remains a human editing that profile in Studio, which is a separate, visible act |
| Approval fatigue | Human rubber-stamps because the diff is unreadable | The Inbox shows effective configuration and dangerous permissions explicitly, not raw YAML |
| **Proposal flooding** | A confused or looping agent fills the Inbox; no single proposal is ever approved, but the queue stops being usable — a denial of the human's attention rather than of the system | Per-proposer pending-proposal ceiling, and identical re-proposals collapse on their digest instead of queueing twice. Refusal is by name, so the loop is visible rather than silent |

## Non-goals

- Unifying Probe and Agent, or turning terminals/processes into agents.
- Making every instance persistent, or storing credentials/transcripts/caches/private homes in a Profile.
- A generic template language, or rewriting all runtime adapters at once.
- Changing public Bridge contracts in phase 1.
- Full long-tail runtime parity as a precondition for the architecture.

## Alternatives considered and discarded

- **Build a new unified spawn port.** Still discarded, but NOT for the reason the first draft gave.
  That draft said "`AgentManager.spawn` already is one", which adversarial review falsified — `commitFork`
  is a second implementation. The surviving reason is different and weaker in scope: converge fork ONTO
  the existing door rather than author a third path beside both. "Converge fork onto the existing port"
  is not the same claim as "the port is already unique", and this line is kept explicit so a reader of
  `spec.md` alone cannot reconstruct the premise that was withdrawn.
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

## Where the creation door is open today (2026-07-29)

Stated explicitly because an optional dependency that nobody declares is a silent gap rather than
staging — raised by `claude-reviewer` on slice C and worth answering in the spec rather than only in a
commit message.

| Deployment | Propose | Review / deny | Approve → create |
| --- | --- | --- | --- |
| VS Code extension as shipped | yes, with `grants.proposeSavedAgent` | yes | yes |

The door is wired, and wired onto seams that already exist: `commitAgentProfileStudio` with no
`expectedRevision` IS the canonical create and already crosses the engine/shell boundary as
`agent-profile.studio-commit`; `set-subagents` crosses it too. No new operation and NO PROTOCOL BUMP
were needed — an earlier reading of mine said otherwise and was incomplete.

The gate that remains is the capability: no profile in this repository holds
`grants.proposeSavedAgent`, so nothing can propose until a human grants it in Agent Studio.

## Ratified decisions (human, 2026-07-29)

These were the open questions. They are answered, and the answers are now requirements — the fifth
one changes measured behaviour, so it is called out rather than filed.

1. **The creation door ships in v1.** It is a Bridge *proposal* tool. An agent never writes or creates
   directly, under any circumstance.
2. **Temporary → Saved promotion uses the same door**, and carries no session, transcript, credentials,
   memory or cache across the boundary.
3. **Official vocabulary: Saved Agent, Temporary Agent, Probe.**
4. **A pending proposal lives 24h**, survives a restart, collapses an identical digest, and is
   invalidated when its CAS/base state diverges.
5. **Lineage becomes symmetric and durable** for Saved and Temporary alike, for the life of the
   instance — and never becomes `declaredOwner`.
6. **Promotion does not mutate a live instance.** Approval creates the Saved Profile; the running
   execution stays Temporary with the hooks and policies it launched with. `Restart as Saved` is a
   separate, explicit action, and only the NEXT instance is born Saved. (This is what removed the
   need for a declared `authority` axis: the design refuses the hybrid state rather than modelling
   it. Hooks are still a RECORDED capability, never derived from identity.)
8. **The proposer becomes the new agent's declared owner**, and v1 REFUSES any other ownership claim:
   a proposal may not declare subagents or reparent an existing agent. Reparenting is a roster edit
   wearing a creation request — a different decision with a different blast radius, and one the human
   would be approving without having been asked about it.
9. **"Approve and save" writes the agent DISABLED**; starting it is a separate action with its own
   policy. `lifecycle.enabled: false` is written by the canonical create, so this is a property of the
   data rather than the conduct of one code path.
7. **`declared` stays on the wire, with a compatible meaning, for this phase.** It is not removed,
   renamed, or silently reinterpreted. Phase 5 may add policy fields and migrate or retire the legacy
   one, but only with an explicit protocol bump, cross-version proof, and a compatibility window.
   **Phase 4's governed door must not depend on that wire change** — the door has to work against the
   protocol exactly as it stands today.

### What decision 5 changes

The SDD had recorded lineage asymmetry as deliberate: ad-hoc parents persist, declared parents are
stripped by `stripDeclaredParent` (`src/resume/SessionLedger.ts:484`). The human resolved it the other
way — both are durable. So that function's declared-only strip is now a defect to remove rather than a
behaviour to preserve, and the acceptance criterion below replaces the one the second draft deleted.

- [ ] **Scenario: a Saved agent's parent survives a restart**
  - **Given** a Saved (declared) instance that was spawned with a runtime parent
  - **When** the engine restarts and rehydrates
  - **Then** its parent edge is still there, exactly as a Temporary agent's already is
  - **And** the parent is still not `declaredOwner`: profile ownership is untouched by this, and
    neither edge is derived from the other
- [ ] **Scenario: lineage is bounded by the instance, not by the profile**
  - **Given** a Saved instance whose lineage was recorded
  - **When** that instance ends and a new instance of the same profile starts
  - **Then** the new instance does not inherit the old lineage — "durable for the life of the
    instance" is the bound, and a profile is not an instance
