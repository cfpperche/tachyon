# 490 — formation-authority-bootstrap

_Created 2026-08-04._

**Status:** draft

**Ratification:** locked on 2026-08-05. The maintainer approved the revised draft and authorized
implementation ("pode tocar"), adding one binding amendment: **parity with codex and grok, not just
claude**. Route (1) of the three recorded in `t-d48775` j-9948625daec2. Revised the same day against
`review-codex.md` (2 P0, 3 P1 — all dispositions applied below).

**Decisions taken at ratification** (each was an open question in the draft):

1. **Adoption lives in Agent Studio**, beside the lane fields that are inert today. SDD 478 M6 made
   "a refusal must name the fix" contractual; the fix belongs one click from the refusal, not on
   another surface.
2. **This EXTENDS SDD 427, it does not amend it.** 427 says workspace bytes cannot activate
   themselves. Adoption is the human act 427 always presupposed and never specified — nothing in it
   is contradicted. Calling this an amendment would claim a rule changed when only a gap was filled,
   and would weaken 427 for whoever reads it next.
3. **`claude` is measured first** — three verified axes at 2.1.220 against zero for codex — but see
   the parity amendment below: first is not only.

**Planning task:** `t-fb9087` (p0) · **Blocked by this:** `t-d48775` (p0), `t-c1ef82` residues 2–3

## Intent

Tachyon has a complete formation-lane mechanism for the two durable per-agent prompt inputs — `soul`
(who the agent is) and `instructions` (what it persistently does). Both are file-backed, digest-bound,
and composed by `promptLayers.ts`. Neither reaches a single agent that can exist today.

The mechanism is gated on a `FormationAuthorityVector`: a record saying *this profile is the canonical
authority for this agent, and a human put it there*. **Nothing in production ever creates one.** The
`bootstrap` mutation exists in the store (`authorityStore.ts:122`), but the only production store is
deliberately read-only (`lifecycleHost.ts:88-96`), so `store.currentVector(agentId)` is always
`undefined` and every real agent resolves to `absent`.

The product already says this out loud, in a named refusal (`Workspace.assertSoulMutable`):

> `soul/canonical-profile-unsupported` — *"Soul for a canonical agent belongs to the formation lane
> (SDD 427), which is not yet wired to the spawn path"*

This became total, rather than partial, on **2026-07-25**: `b4930e2b` retired the inline agent format,
and every declared agent is now a canonical profile pointer. The legacy shapes that used to deliver
these inputs stopped being expressible in the same commit that removed their format.

What is missing is the **moment zero**: someone must be able to say *"this `agent.yml`, already on
disk, is from now on the canonical authority for this agent"* — and by SDD 427's delivered acceptance
criterion, that someone cannot be the file.

Done means a maintainer can adopt an existing Saved Agent's profile under authority through the
product, and from that point the soul and instructions lanes **deliver at spawn**.

### Two things the review proved the first draft got wrong

**The publisher named in the first draft cannot perform moment zero.** Every
`HumanLaneTransactionService` path requires an existing `currentVector` and throws a CAS mismatch
without one (`humanLaneTransactions.ts:352-358`); it knows only `profile-edit` and `retire`. So
"give it a production caller" was the wrong guard — satisfiable by something that never bootstraps,
while a raw `authorityStore.replaceVector(… mutation: "bootstrap")` path could adopt with no custody
or audit guarantee at all. This spec now specifies the bootstrap door itself.

**Authority and delivery do not separate at the product boundary.** The first draft declared measured
native suppression a non-goal, reasoning that it gates delivery and not authority. In production
`nativeSuppressionConfirmed` is hard-coded `false` for every adapter (`Workspace.ts:3034`), and the
lifecycle refuses *before* resolving the payload when it is false (`lifecycleHost.ts:117-120`). Under
that non-goal this spec could land whole — adoption working perfectly — and every spawn would still
refuse, leaving the maintainer's original defect exactly where it was. That is the appearance of a
fix, which is the disease this repository already tracks in `t-f33480`. Measured suppression stays a
separate implementation task, but it is now a **declared prerequisite** of the delivery criteria
rather than a non-goal.

### Why the obvious shortcut is refused

Deriving the vector from `agent.yml` at load or at save is out of scope by prior ratification: SDD 427
`spec.md:297` carries *"workspace bytes cannot activate themselves"* as a criterion **marked
delivered**. A file that authorizes itself undoes that from the inside, silently. If this spec wants
that shortcut, it must amend 427 explicitly and say why.

The review confirmed there is no competing claim on moment zero: the Evolution and selected-memory
publishers both require an already-active vector (`evolutionTransactions.ts:59-69`,
`memoryTransactions.ts:51-61`), so neither is an alternative bootstrap path.

## Acceptance criteria

### Authority — deliverable on its own

- [x] **Scenario: a maintainer adopts an existing Saved Agent under authority** — *port delivered
      (Fatia A); the Agent Studio gesture that calls it is a follow-up, see below.*
  - **Given** a canonical Saved Agent whose `agent.yml` is on disk with no `FormationAuthorityVector`
  - **When** the maintainer performs the adoption action in the product
  - **Then** generation 1 is published atomically, bound to the exact current profile and lane digests,
    the workspace id and the agent identity, with a durable record of who, when, and from which bytes

- [x] **Scenario: the file still cannot activate itself**
  - **Given** an unadopted agent whose `agent.yml` declares lane content by hand
  - **When** it is loaded and spawned
  - **Then** no vector is created and no lane content is delivered

- [ ] **Scenario: an unadopted agent is honest, not broken** — *the state the fields need
      (`Workspace.inspectFormationAuthority`: unadopted / adoptable / the blocking reason) is
      delivered and tested; the fields themselves still read it.*
  - **Given** a Saved Agent nobody has adopted
  - **When** the maintainer opens Agent Studio
  - **Then** the lane fields state that this agent has no authority yet and name the adoption action —
    they are never present, inviting and inert

- [x] Exactly **one** production door reaches `mutation: "bootstrap"`, and a test fails if a second
      production path to that mutation appears — including a *dynamic* one that never names it.
      **Amended at implementation:** the criterion said "authenticates a human actor". Measured, this
      repository cannot: `controlPeerAuth.ts` proves same-uid (every spawned agent shares the uid) and
      `resolveCaller` never mints `kind: "human"`. The property the door actually holds is
      **unreachability** — not an `ExtensionCommandV1` action, not a `vscode.commands` id, not a
      `WorkspaceAgentStudioTarget` member. It is described that way everywhere, and the residue is
      named: code executing inside the extension host is indistinguishable from the human.
- [x] The Interface / Agent / Tachyon × create / restart / recovery matrix of callers is enumerated,
      each with its expected refusal. *(`agentFormationBootstrap.test.ts` — non-human callers at both
      the door and the host, the spawn host's read-only store, the three agent-facing routes, the
      dynamic pass-through, replay of one operation id, and crash recovery.)*
- [ ] Adoption is ratified as **workspace × agent** — the model the code already enforces
      (`domain.ts:194-209` rejects cross-workspace heads; the store lives under the workspace root at
      `Workspace.ts:3020-3025`) — with named tests for: two windows on one root, the same agent
      identity in two workspace roots, concurrent adoption under CAS, and reopen/restart.
      *Ratified and enforced (the adoption host refuses a foreign `workspaceId`; concurrent adoption
      under CAS is tested). Two-windows-on-one-root and reopen/restart need a two-`Workspace` harness
      Fatia A did not build — see `notes.md` open question 3.*

### Delivery — **prerequisite: measured native suppression for the runtime under test**

These two cannot be ticked while `nativeSuppressionConfirmed` returns `false` for the runtime being
exercised. That measurement is `t-fb9087` item (2) and may ship separately, but this spec is **not
delivered** while every spawn refuses.

- [ ] **Scenario: instructions written through the product reach the agent**
  - **Given** an adopted Saved Agent on a runtime whose native lane suppression has been measured
  - **When** the maintainer edits persistent instructions in Agent Studio and restarts through the
    production door
  - **Then** a manifest that attests `agentId`, `workspaceId`, the formation generation and its digest,
    the lane source, and **the digest of the instructions actually composed** shows the edited bytes
  - **And** a negative control proves unrelated or legacy definition instructions cannot satisfy that
    assertion

- [ ] **Scenario: soul reaches an adopted agent too**
  - **Given** an adopted Saved Agent with a canonical soul lane, same suppression precondition
  - **When** it spawns fresh through the production door
  - **Then** the composed prompt binds the adopted soul digest and the authority generation
  - **And** Agent Studio's canonical soul action routes to the governed lane publisher, while the
    inline `soul:` mutation path remains impossible

### Invariant

- [ ] SDD 427's criterion *"workspace bytes cannot activate themselves"* still holds after this ships,
      or this spec carries an explicit, reasoned amendment to 427 saying it no longer does.

## Non-goals

- ~~**Measuring native suppression for every runtime.**~~ **REMOVED at ratification.** The first
  draft said one measured runtime was enough. The maintainer amended this: **parity across `claude`,
  `codex` and `grok`** — the three runtimes that carry `savedAgentProfile: true`, and therefore the
  three that can hold an adopted vector at all. A spec that adopts an agent under authority and then
  delivers on only one of the three runtimes it supports would move the refusal rather than remove
  it, for anyone whose Saved Agent is not `claude`.

  Scope note, measured: the suppression receipt covers **every enabled human lane at once** — it is
  rejected unless its lane set exactly equals the vector's `mode: "profile"` lanes
  (`humanLanes.ts:57-62`). So this is not the memory registry's `disable` axis alone. On that axis
  `claude` and `grok` are already `verified` and `codex` is only `declared`
  (`src/runtime/nativeMemory.ts`), but native *rules/instructions* delivery (`CLAUDE.md`,
  `AGENTS.md`, and each runtime's equivalent) has to be measured too before a receipt can honestly
  be issued.
- **Bulk adoption UI.** Legitimately out of scope; per-agent adoption is the contract.
- **Merging soul and instructions into one lane.** Measured 2026-08-04 and rejected: `soul.ts` is 950
  lines against 104 in `persistentInstructions.ts`, and `promptLayers.ts:100-103` deliberately declaws
  the soul layer. SDD 377 is ratified. The review did not reopen this.
- **Retiring either lane for disuse.** The usage evidence is produced by a closed door.
- **Reviving the inline agent format.**
- **The `App.tsx:1488-1489` residues** (`t-c1ef82` items 2–3) — downstream of this.

## Open questions

1. **Where does adoption live?** Agent Studio (next to the lane fields that today are inert), or a
   distinct governed operation in the Fleet/roster surface? Owner: maintainer.
2. **Does adoption need to be reversible, and what does un-adoption mean for content already published
   to a lane?** Owner: `plan.md`, against `agentForgetPlan.ts`, which already models governed removal.
3. **Does this amend SDD 427, or extend it?** Owner: maintainer, on reading 427 §297.
4. **Does instructions get its own port method, or does `resolveSoul` become `resolveLanes`?**
   `lifecycleHost.ts:145` already resolves the full payload and discards `payload.instructions` — the
   data is there and thrown away. Owner: `plan.md`.
5. **Which runtime is measured first?** `claude` has the most verified axes today
   (disable/enable/isolation verified at 2.1.220); `codex` has a firmer quota channel but every memory
   axis merely declared. Owner: `plan.md`, informed by `docs/runtimes/parity.md`.

_Question 2 of the first draft ("per-agent or per-workspace") was closed by the review: adoption is
workspace × agent, which is what the code already enforces. It is now an acceptance criterion._
