# 482 — unified-agent-instance — notes

## Measurement log — the current code, 2026-07-28

Read before designing, because the proposal (`docs/proposals/unified-agent-instance.md`) describes
canonical and ad-hoc as "two technical species" and the code does not agree with that in the place it
matters most. Everything below is a citation, not a recollection.

### The execution path is ALREADY one path

- `AgentManager.spawn(name, opts)` (`src/agents/AgentManager.ts:1675`) is the **only** spawn door.
  Every caller goes through it — the Bridge's `spawn_agent` (`src/bridge/tools.ts:1866`), the pipeline
  (`Workspace.ts:2499`), schedules (`Workspace.ts:5795`), `continue_task` (`Workspace.ts:3789`),
  handoff distillation, and the Activity-logged UI start. There is no second spawn implementation to
  merge.
- Runtime home materialization, config projection, permissions, tools, Attention, Activity, Execution
  Graph, worktree and cleanup all hang off that one path already.

**Consequence for the architecture: "unify the two spawn paths" is not the work, because it is
already done.** Saying otherwise in an SDD would send an implementer looking for a duplicate that
does not exist.

### What IS duplicated: the definition store, and only that

```ts
// src/agents/AgentManager.ts:959
private definitionOf(name: string): AgentDef | undefined {
  return this.opts.getConfig()?.agents[name] ?? this.adhoc.get(name);
}
```

Two stores, one resolution point:

| | Saved / canonical | Temporary / ad-hoc |
|---|---|---|
| definition source | `config.agents[name]` — `tachyon.yml` / profile | `private adhoc = new Map<string, AgentDef>()` (`:888`) |
| durability | the file, human-owned | `SessionLedger` (`.tachyon/sessions.json`), rehydrated by `rehydrateFromLedger()` (`:1206`) |
| identity flag | `declared: true` | `declared: false` (`src/resume/SessionLedger.ts:145`) |

### The load-bearing correction: ad-hoc agents ARE durable

The in-code comment at `AgentManager.ts:889` says lineage is "session-local memory" — that is true of
**lineage**, and reading it as true of ad-hoc agents in general is the mistake this note exists to
prevent. `SessionLedger` persists `def` for every ad-hoc agent (`:136-137`) and
`rehydrateFromLedger()` restores it, so a Temporary agent already survives an extension restart.

What genuinely does NOT survive is the parent edge: `lineage` and `delegators` are in-memory maps
(`:889`, `:892`), and the ledger actively strips a declared agent's parent (`stripDeclaredParent`,
`SessionLedger.ts:485`). So today an agent's *identity* is durable while its *lineage* is not.

**That asymmetry, not the two stores, is the defect with user-visible consequence** — after an engine
restart a Temporary agent is still there and still governed, but nobody can say what spawned it.

### `declared` is a storage fact being used as an identity fact

`declared: boolean` answers "which store did this come from". It is then read as though it answered
"what kind of worker is this" — `declared+autostart auto-resumes, others are offered`
(`SessionLedger.ts:144`). Those are two different questions that happen to correlate today. The
unification is mostly the work of separating them into `identity` (does a durable Profile back this?)
and `lifetime` (may it be restarted/resumed, or is it collected when the work ends?).

### Ownership vs lineage — already two edges, already correct

- `subagents` → derived `declaredOwner` (`src/config/loadConfig.ts:448`, `:1127-1166`): Saved Profile
  → Saved Profile, configuration ownership, no operational authority.
- runtime `parent` (`lineage`): Instance → Instance, execution/delegation.
- `delegators` (`:892`) is display-only, and gated children deliberately have no runtime parent.

The proposal's instruction to keep these distinct is a request to **preserve** current behavior, not
to build something. The risk is regression during migration, so it belongs in the invariants.

### Probe is genuinely separate

`ProbeService` (`src/probe/ProbeService.ts:91`) with its own envelope (`src/probe/taxonomy.ts:125`).
It shares runtime adapters and model-proof machinery and has no Fleet presence, task, worktree or
continuity. Nothing in this design touches it; the non-goal is real and already holds.

### Admission is already declared, not inferred

`SUPPORTED_ADHOC_AGENT_RUNTIMES` (`src/agents/adhocAdmission.ts:130`) with
`admitAdhocAgentCommand` — SDD 478 M9 already replaced "infer the kind from the command" with a
declared capability list. The proposal's "must not infer agent kind from command, name, tmux session,
or presence in tachyon.yml" is therefore already true for the command axis and needs holding, not
inventing.

## What this measurement changes about the proposal

1. The migration's first four steps ("create one internal spawn/start port", "adapt Temporary to it",
   "adapt Saved to it") collapse: there is one port and both already use it.
2. The real sequence starts one step later — at the definition/identity model.
3. A new item the proposal does not list becomes phase-1 work, because it is the only user-visible
   defect measured here: durable lineage.
4. The governed creation door (the long requirement list in `t-5e1113`) is entirely new surface. It
   is the largest genuinely-new piece of this task and carries all of the security weight.
