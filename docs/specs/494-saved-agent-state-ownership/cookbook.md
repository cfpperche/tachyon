# Cookbook — saved-agent-state-ownership

_Operator/agent how-to for this shipped surface. Not the contract (`spec.md`) and not build memory (`notes.md`).
Write at ship time when the change introduces a usable API, Bridge tool, CLI, or lifecycle that a sibling agent
or human would otherwise reverse-engineer from code._

Part 4 shipped one tool, `reconcile_roster`, and one change to a string a human already reads.

## When to use

- A Saved Agent looks broken and you do not know where to take it out. This is the question the tool
  was built for: it names the door.
- A row is in the sidebar but Agent Studio refuses it, or a name appears in one record and not in
  another, and you want to know which record is the odd one out.
- You are about to propose a removal and want to know whether the agent is a member first, because a
  non-member has no removal door at all.

## When not to use

- You want to know whether an agent can RUN. That is runnability, and the refusal string already
  answers it. `reconcile_roster` tells you which records disagree, not how to make the agent work.
- You want to remove something. The tool is read-only and always will be. It names a door; you walk
  through the door yourself.
- You want worktree residue or task outcomes. Those are `reconcile_worktree_hygiene` and
  `reconcile_task`.

## The four facts and the five states

Four records hold a Saved Agent's presence, and each one owns a different fact:

| Fact | Owner | Where |
|---|---|---|
| `rosterRow` | the roster | the `agents:` pointer in `tachyon.yml` |
| `profileOnDisk` | the canonical profile | `.tachyon/agents/<name>/agent.yml` |
| `authorityRecord` | the host authority | SecretStorage, keyed by workspace hash |
| `projection` | nobody | derived on every load from the profile, the authority and the runtime's own global config |

The state is which of them disagree. It is derived on every call and stored nowhere, because three of
the four facts live outside Tachyon's records — `~/.claude/settings.json` is the one that changed the
answer for `claude23`, and any tool on the machine may rewrite it.

| State | What disagrees | Member? | Door |
|---|---|---|---|
| `consistent` | nothing | yes | Agent Studio Forget |
| `orphan-locator` | roster row, no profile | yes | Agent Studio Forget |
| `unattested` | roster and profile agree, no authority | yes | Agent Studio Forget |
| `unprojectable` | all three agree, the projection fails | yes | Agent Studio Forget |
| `unlisted-profile` | profile on disk, no roster row | **no** | none — the profile is kept |
| `stranded-authority` | authority only | **no** | none — no member to remove |

A member is removable even when it cannot run. That is the whole point of SDD 494: removal reads
membership, never runnability.

## Happy path

1. Call `reconcile_roster` with no arguments.
2. Find the agent. Read `state` first, then `removal.door`.
3. If `removal.door` is a string, use it: Agent Studio's Forget button, or
   `propose_saved_agent_removal` from the Bridge.
4. If `removal.door` is `null`, read `removal.reason`. There is no member to remove, and the residue
   is deliberately left alone.
5. `refusal` is present only when the load refused the agent, and it carries the runtime's own words.
   The state and the refusal are reported apart on purpose: the state says which records disagree, the
   refusal says what the runtime said.

## Reading the sidebar row instead

The refusal string on the row now starts with the state and the two owners that disagree, for example
`unprojectable — the profile and the runtime configuration disagree. profile: profile/native-config-value: …`.
`list_agents` returns the same string. Use the row for a glance and the tool when you need the facts.

## Tools / commands

| Action | Tool or command | Notes |
|--------|-----------------|-------|
| Ask which records disagree | `reconcile_roster()` | Read-only, no arguments. Reports every name any of the four records knows. |
| Remove a member | `propose_saved_agent_removal(name, rationale)` | The Bridge door. A human approves it. |
| Remove a member as the human | Agent Studio → Forget | The same governed transaction, journaled under `.tachyon/canonical-agent-transactions/forget/`. |

## Fail-closed / safety

- The tool writes nothing. It cannot be a removal door by accident.
- A state with no roster row never gets a door, so nothing automatic can delete a profile directory
  that may hold a human's work. An automatic delete on a disagreement would turn a display bug into
  data loss.
- The presence facts decide before the projection does. A projection that somehow succeeded while a
  record was missing does not get reported as `consistent`; the missing record still decides.
- The report is a snapshot of the moment you asked. It is safe to ask again — that is cheaper than
  trusting an old answer.

## Cleanup

None. Nothing is written and nothing is cached.

## See also

- Contract: [`spec.md`](./spec.md), including the six doors that can create `unlisted-profile`.
- Measurement: [`evidence/measurement-2026-08-06.md`](./evidence/measurement-2026-08-06.md) — why
  `claude23` is refused correctly and was still unremovable.
- Spec `471-claude-bypass-permissions-optin` — the refusal itself, which this spec does not change.
