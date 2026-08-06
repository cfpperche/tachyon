# 494 — saved-agent-state-ownership

_Created 2026-08-06._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

The state of a Saved Agent lives in several places. No record says which place decides.
The product therefore creates an agent that it cannot remove.

`claude23` is that agent. It exists in this workspace now. It is the live reproduction of
`t-02e72c`. Do not delete it by hand.

The measurement is in `evidence/measurement-2026-08-06.md`. It was written before this spec.
It refutes four premises of `t-f353bc`, and two of them change what must be built.

**The refusal is not the defect.** `claude23` selects the Claude permissions family from the
global file and declares no authorization. `~/.claude/settings.json` sets
`permissions.defaultMode: bypassPermissions`. Spec `471-claude-bypass-permissions-optin`
shipped that refusal on purpose. Inheritance alone must never grant that authority.
`claude23` is refused correctly.

**The defect is that a correct refusal deletes the agent from the map that removal reads.**
The config loader removes every non-projectable agent from `config.agents`. Every removal
door asks `config.agents` whether the agent exists. The answer is no. The Agent Studio plan
therefore throws, the error arrives on a different channel, and the dialogue shows
"Computing what this will do…" until the human gives up.

One map answers two different questions today:

- Does this agent EXIST? — membership.
- Can this agent RUN right now? — runnability.

Runnability is derived. It depends on a file on the host that Tachyon does not own. When it
is false, the agent stops existing for every door except the sidebar row. That is the bug.

Done looks like this. Each fact of a Saved Agent's state has one named owner. Membership
survives every disagreement between owners. Runnability survives none. Removal reads
membership. An agent in any inconsistent state can be removed through a door the product
owns, and the removal says what it did. The roster moves out of `tachyon.yml` into a
machine-local document, because the fleet and the project settings have different owners.
The migration loses no agent, runs twice safely, and reports its result.

## The ownership table

This is the contract. Each row names one fact, one owner, and one location. An owner is the
record that DECIDES the fact. Every other place that holds the same fact is a copy.

| Fact | Question it answers | Owner | Location |
|---|---|---|---|
| Membership | Does this agent exist in this workspace? | the local roster | `.tachyon/roster.json` |
| Definition | What is this agent? | the canonical profile | `.tachyon/agents/<name>/agent.yml` |
| Attestation | Did a human approve THESE profile bytes? | the host authority | SecretStorage, `tachyon.agentProfileAuthorities.v1.<wsHash>` |
| Liveness | Is a session running now? | the tmux session and the ledger | process state |
| Runnability | Can this agent launch right now? | **nobody** | derived on every load |

Runnability has no owner on purpose. It is computed from the profile, the authority and the
runtime's own global configuration. It is never stored and never trusted across a load.

A fifth place holds an input that Tachyon does not own:

| Input | Owner | Location |
|---|---|---|
| Runtime global configuration | the host machine and the runtime | `~/.claude/settings.json`, and the equivalent per runtime |

Any tool on the machine may write that file. Tachyon reads it. Tachyon must never assume it
is unchanged since the last load. `claude23` is refused because that file changed the answer,
and nothing recorded the change.

## When the owners disagree

The general rule has one sentence. **A fact that cannot be proven makes an agent unrunnable.
It never makes an agent non-existent.**

Five disagreements are possible. Each has one resolution.

| State | What disagrees | Resolution |
|---|---|---|
| `orphan-locator` | roster has the row, no profile on disk | member, not runnable, removable. Removal edits the roster only. |
| `unlisted-profile` | profile on disk, no roster row | NOT a member. The profile stays. Offer adoption. Never delete it automatically. |
| `unattested` | roster and profile agree, no authority | member, not runnable, removable. A human may re-approve to repair it. |
| `unprojectable` | roster, profile and authority agree, projection fails | member, not runnable, removable. **This is `claude23`.** |
| `stranded-authority` | authority exists, no roster row and no profile | not a member. Retire the authority. |

The state is derived, like runnability. It is never stored.

`unlisted-profile` and `stranded-authority` do not auto-delete, and that is deliberate. A
profile on disk may hold work a human wants. An automatic delete on a disagreement would turn
a display bug into data loss.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

### Removal of an inconsistent agent

- [ ] **Scenario: the forget plan computes for an unprojectable agent**
  - **Given** `claude23`, whose profile, roster row and host authority all exist, and whose
    projection fails with the spec 471 refusal
  - **When** a human opens Agent Studio and asks to forget it
  - **Then** the plan renders with a state for every step, and the dialogue never stays on
    "Computing what this will do…".
- [ ] **Scenario: the plan reports the roster row that actually exists**
  - **Given** the same agent, whose name IS present in the roster document
  - **When** the plan is computed
  - **Then** the `remove-locator` step reports `will-run`, and never reports `satisfied`.
- [ ] **Scenario: the forget completes and leaves nothing behind**
  - **Given** an approved plan for `claude23`
  - **When** the human confirms the forget
  - **Then** the roster row, the profile directory and the host authority are all gone, a
    journal entry is written under `.tachyon/canonical-agent-transactions/forget/`, and a
    reload shows no `claude23` row.
- [ ] **Scenario: an agent that is refused for a reason a human can repair stays repairable**
  - **Given** `claude23` and a human who authorizes `bypassPermissions` for it instead of
    removing it
  - **When** the profile is saved and the config reloads
  - **Then** the agent projects, becomes runnable, and no forget was required to fix it.
- [ ] **Scenario: an agent with a missing profile is still removable**
  - **Given** a roster row whose `.tachyon/agents/<name>/` directory was deleted by hand
  - **When** a human asks to forget it
  - **Then** the plan computes, the profile step reports `satisfied`, and the removal clears
    the roster row and the authority.
- [ ] **Scenario: the Bridge removal door agrees with the Agent Studio door**
  - **Given** any agent in one of the five disagreement states
  - **When** an agent calls `propose_saved_agent_removal` for it
  - **Then** the proposal is accepted for review, and it is not refused on the ground that
    the agent is "not backed by a canonical profile".

### Membership does not depend on runnability

- [ ] **Scenario: a refused agent remains a member**
  - **Given** a workspace whose only agent is refused
  - **When** the config loads
  - **Then** the config loads, the workspace settings are in effect, and the agent appears as
    a member that cannot run.
- [ ] **Scenario: a copied roster degrades the fleet and not the workspace**
  - **Given** a roster and its profiles copied to a path whose authority was never written,
    so every agent is `unattested`
  - **When** the config loads
  - **Then** `verify`, `projectGuidance`, `maxAgents` and `auth` are all in effect, and every
    agent is reported as a member that cannot run.
- [ ] Membership is read from the roster document and from no other source.
- [ ] No removal door reads runnability to decide whether an agent exists.

### The roster document

- [ ] The roster lives at `.tachyon/roster.json`, which is machine-local because `.tachyon/`
      is ignored by Git.
- [ ] The document carries an explicit `schemaVersion`.
- [ ] An invalid document is refused whole, and the last known good roster stays in effect.
- [ ] A refused roster is reported to the human through the surface that already reports a
      refused config, and never fails silently.
- [ ] Every write is a temp file plus a rename.
- [ ] Each entry carries an explicit `origin`, whose only legal value in this spec is `local`.
- [ ] `tachyon.yml` keeps the `settings` section, and its schema no longer defines `agents`.

### The migration

- [ ] **Scenario: the first migration copies every agent**
  - **Given** a workspace with `tachyon.yml` declaring `claude`, `claude-cowntdown` and
    `claude23`, and no `.tachyon/roster.json`
  - **When** the workspace loads
  - **Then** `.tachyon/roster.json` is written with all three names and their profile
    pointers, `tachyon.yml` is not modified, and the result is reported.
- [ ] **Scenario: the migration is idempotent**
  - **Given** a workspace where the migration already ran
  - **When** the workspace loads again
  - **Then** the roster is not rewritten, no agent is duplicated, and the report says the
    migration had already run.
- [ ] **Scenario: the migration never touches the authority**
  - **Given** any workspace with attested agents
  - **When** the migration runs
  - **Then** no SecretStorage key is read for writing and no authority record changes, so
    every attested agent stays attested.
- [ ] **Scenario: leftover `tachyon.yml` rows are residue, not a second roster**
  - **Given** a migrated workspace whose `tachyon.yml` still declares `agents`
  - **When** the config loads
  - **Then** `.tachyon/roster.json` decides membership, the `tachyon.yml` rows are ignored,
    and the human is told the section is residue that they may delete.
- [ ] **Scenario: a failed migration changes nothing**
  - **Given** a `tachyon.yml` whose `agents` section cannot be read
  - **When** the migration runs
  - **Then** no roster document is written, and the failure is reported with the reason.

### Naming the disagreement where a reader already looks

- [x] **Scenario: the sidebar row says which owners disagree**
  - **Given** an agent in any of the five states
  - **When** the fleet is projected to the sidebar
  - **Then** the existing refusal string on the row names the state and the owners that
    disagree, and the row stays visible.
- [x] **Scenario: an agent can ask what disagrees**
  - **Given** an agent diagnosing a fleet problem through the Bridge
  - **When** it asks for the roster reconciliation
  - **Then** it receives, per agent, the membership fact, the four owner facts, the derived
    state, and the door that would remove it.
- [ ] Every mechanism this spec adds has a consumer that exists today, and the plan names it.

## Non-goals

- **No shared or team roster.** The owner decided on 2026-08-06: "como ferramenta de uma
  pessoa, futuramente podemos expandir para times ... mas por agora uma pessoa." The `origin`
  field keeps the door open. This spec delivers only `origin: local`.
- **No change to the spec 471 refusal.** `bypassPermissions` stays refused without an explicit
  per-agent authorization. This spec makes a refused agent removable. It does not make it run.
- **No repair of `tachyon.yml.example` or the backup file.** Both still declare retired inline
  agents, so both fail to load. That is a separate defect and belongs in its own task.
- **No new panel, view or report surface.** Every fact this spec produces is delivered through
  a surface that already has a reader.
- **No move of project settings.** `tachyon.yml` keeps `settings`. It loses only `agents`.
- **No standing reconciliation report.** See the open question below.
- **No hand deletion of `claude23`.** It is the acceptance fixture for the first scenario.

## Open questions

- **Who removes the residual `agents` section from `tachyon.yml`?** The proposal is the human.
  The product stops owning that section at migration, so writing to it afterwards would
  contradict the ownership table. The cost is that the residue is visible until someone
  deletes it. Resolve before the plan is agreed.
- **Should the runtime's global configuration be snapshotted?** An agent that ran yesterday
  can refuse today because another tool wrote `~/.claude/settings.json`. Nothing records that
  the input changed, so the human sees a new refusal with no cause. A snapshot would name the
  cause. It also adds a sixth place to keep in agreement, which is what this spec is trying to
  reduce. Owner: the human. Not resolved here.
- **Is `unlisted-profile` reachable today? RESOLVED 2026-08-06 (Part 4, `t-6c029b`): yes, by six
  doors, so its handling stays "report it and keep the profile" and does NOT become a refusal to
  act.** The measurement did not produce one because it never edited `tachyon.yml` by hand. The
  doors, each read at the point of use:

  | # | Actor | Trigger | Durable? |
  |---|---|---|---|
  | 1 | Human | delete an agent's row from `tachyon.yml` in a text editor | yes, nothing recovers it |
  | 2 | Agent | `write_tachyon_config` writes the whole file and omits a row | yes, nothing recovers it |
  | 3 | Human | copy a profile directory into `.tachyon/agents/` | yes, no product code ran |
  | 4 | Human or Agent | `commitAgentProfileLifecycle` create, crashed between `profile-published` and `locator-written` | no, `reconcileAgentProfileLifecycle` closes it |
  | 5 | Human | `commitAgentProfileForget`, crashed between `locator-removed` and `home-quarantined` | no, `reconcileAgentProfileForgets` closes it |
  | 6 | Human or Agent | `commitAgentProfileRename`, crashed between `profile-moved` and `locator-written` | no, `reconcileAgentProfileRenames` closes it |

  Door 1 is already covered by a test: "Human, text editor x edit tachyon.yml" in
  `test/unit/workspaceHeadless.test.ts` deletes the row and asserts the profile is still on disk.
  That test WAS an `unlisted-profile` before this question had a name.

  The three transactional windows are transient by design and the three reconcilers close them, so
  they are not what decides this question. Doors 1 to 3 do: they are durable, no reconciler owns
  them, and two of the three are ordinary use of a documented surface.

  What the resolution changes: nothing in the resolution table above. `unlisted-profile` keeps
  "the profile stays, never delete it automatically", `reconcile_roster` reports it with no removal
  door, and the reason it gives names the two ways out (restore the roster row, or delete the
  directory by hand). Adoption is still not built — it needs a human who asks for it, and Part 4
  found none.
