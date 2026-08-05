# 490 — formation-authority-bootstrap

_Created 2026-08-04._

**Status:** draft

**Ratification:** PENDING. Drafted from the maintainer's decision on 2026-08-04 ("abre a spec"),
which chose route (1) of the three recorded in `t-d48775` j-9948625daec2. Intent below is a draft
FOR the maintainer to ratify or amend, not a decision already taken.

**Planning task:** `t-fb9087` (p0) · **Blocked by this:** `t-d48775` (p0), `t-c1ef82` residues 2–3

## Intent

Tachyon has a complete formation-lane mechanism for the two durable per-agent prompt inputs — `soul`
(who the agent is) and `instructions` (what it persistently does). Both are file-backed, digest-bound,
and composed by `promptLayers.ts`. Neither reaches a single agent that can exist today.

The mechanism is gated on a `FormationAuthorityVector`: a record saying *this profile is the canonical
authority for this agent, and a human put it there*. **Nothing in production ever creates one.**
`HumanLaneTransactionService` — the only publisher — has zero production callers; its two
instantiations in the whole repository are in `test/unit/agentFormationHumanLanes.test.ts`. So
`store.currentVector(agentId)` is always `undefined`, and every real agent resolves to `absent`.

The product already says this out loud, in a named refusal (`Workspace.assertSoulMutable`):

> `soul/canonical-profile-unsupported` — *"Soul for a canonical agent belongs to the formation lane
> (SDD 427), which is not yet wired to the spawn path"*

This became total, rather than partial, on **2026-07-25**: `b4930e2b` retired the inline agent format,
and every declared agent is now a canonical profile pointer. The legacy shapes that used to deliver
these inputs (`soul: true` and `instructions:` inline in `tachyon.yml`) stopped being expressible in
the same commit that removed their format. The lanes did not regress — their only remaining road was
closed, and the replacement road was never opened.

What is missing is not wiring. It is the **moment zero**: someone must be able to say *"this
`agent.yml`, already on disk, is from now on the canonical authority for this agent"* — and by SDD
427's delivered acceptance criterion, that someone cannot be the file.

Done means a maintainer can adopt an existing Saved Agent's profile under authority through the
product, and from that point the soul and instructions lanes deliver at spawn like the design always
described.

### Why the obvious shortcut is refused

Deriving the vector from `agent.yml` at load or at save is the cheap answer and it is **out of scope
by prior ratification**: SDD 427 `spec.md:297` carries *"workspace bytes cannot activate themselves"*
as a criterion **marked delivered**. A file that authorizes itself undoes that from the inside, and
would do so silently. If this spec wants that shortcut, it must amend 427 explicitly and say why —
not arrive at it by convenience.

## Acceptance criteria

- [ ] **Scenario: a maintainer adopts an existing Saved Agent under authority**
  - **Given** a canonical Saved Agent whose `agent.yml` is on disk with no `FormationAuthorityVector`
  - **When** the maintainer performs the adoption action in the product
  - **Then** a vector is created from the current profile state, the human is recorded as its
    custodian, and the operation is auditable after the fact (who, when, from which bytes)

- [ ] **Scenario: instructions written through the product reach the agent**
  - **Given** an adopted Saved Agent
  - **When** the maintainer edits persistent instructions in Agent Studio and restarts the agent
  - **Then** the agent's composed prompt carries those instructions, proved by the prompt manifest —
    not by the bytes existing on disk

- [ ] **Scenario: soul reaches an adopted agent too**
  - **Given** an adopted Saved Agent with a soul profile
  - **When** it spawns
  - **Then** `resolveSoul` returns `resolved` rather than `absent`, and `createSoulProfile` no longer
    refuses with `soul/canonical-profile-unsupported`

- [ ] **Scenario: an unadopted agent is honest, not broken**
  - **Given** a Saved Agent nobody has adopted
  - **When** the maintainer opens Agent Studio
  - **Then** the lane fields state that this agent has no authority yet and name the adoption action —
    they are never present, inviting and inert

- [ ] **Scenario: the file still cannot activate itself**
  - **Given** an unadopted agent whose `agent.yml` declares lane content by hand
  - **When** it is loaded and spawned
  - **Then** no vector is created and no lane content is delivered

- [ ] SDD 427's criterion *"workspace bytes cannot activate themselves"* still holds after this ships,
      or this spec carries an explicit, reasoned amendment to 427 saying it no longer does.
- [ ] `HumanLaneTransactionService` has at least one production caller, and a test fails if it returns
      to having none.
- [ ] The `FormationLifecyclePort` contract carries a consumer for instructions, or this spec records
      why instructions is deliberately delivered by a different road than soul.

## Non-goals

- **Measuring native suppression per runtime.** `nativeSuppressionConfirmed` returns `false` for every
  adapter, honestly: the receipt attests that a runtime disabled its own native lane delivery, and no
  runtime has had that measured. That work is `t-fb9087` item (2) and it gates *delivery*, not
  *authority*. This spec can ship with every lane still refusing at spawn for want of a receipt — the
  refusal would then be about suppression, not about a missing vector.
- **Merging soul and instructions into one lane.** Measured on 2026-08-04 and rejected: `soul.ts` is
  950 lines against 104 in `persistentInstructions.ts`, and `promptLayers.ts:100-103` deliberately
  declaws the soul layer ("shapes voice, values, posture, and style only"). SDD 377 is ratified.
- **Retiring either lane for disuse.** The usage evidence is produced by a closed door and is
  worthless until the door opens.
- **Reviving the inline agent format.** It is retired and stays retired.
- **The `App.tsx:1488-1489` residues** (`t-c1ef82` items 2–3). They are downstream of this and land
  after it.

## Open questions

1. **Where does adoption live?** Agent Studio (next to the lane fields that today are inert), or a
   distinct governed operation in the Fleet/roster surface? Owner: maintainer. The lane fields are
   where the user discovers the gap, which argues for Agent Studio; a fleet-wide "adopt all existing"
   argues for the roster.
2. **Is adoption per-agent or per-workspace?** All three agents in this repository are unadopted, and
   so is every agent in every existing install. A one-at-a-time flow may be honest and tedious; a
   bulk flow may be convenient and too broad a grant. Owner: maintainer.
3. **Does adoption need to be reversible, and what does un-adoption mean for content already
   published to a lane?** Owner: to be answered in `plan.md` against `agentForgetPlan.ts`, which
   already models governed removal.
4. **Does this amend SDD 427, or extend it?** If adoption is exactly the human act 427 always
   implied, this is an extension and 427's criterion is untouched. If 427 assumed vectors would exist
   by another road, it needs an amendment saying which. Owner: maintainer, on reading 427 §297.
5. **Does instructions get its own port method, or does `resolveSoul` become `resolveLanes`?** The
   port has exactly one method today and `lifecycleHost.ts:145` already resolves the full payload and
   discards `payload.instructions` — the data is there and thrown away. Owner: `plan.md`.
