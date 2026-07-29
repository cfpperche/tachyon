# 482 — unified-agent-instance — notes

## Measurement log — the current code, 2026-07-28

Read before designing, because the proposal (`docs/proposals/unified-agent-instance.md`) describes
canonical and ad-hoc as "two technical species" and the code does not agree with that in the place it
matters most. Everything below is a citation, not a recollection.

### The execution path is one path FOR SPAWN, and fork is a second implementation

> **CORRECTED 2026-07-29 after adversarial review.** The first version of this section said
> `AgentManager.spawn` is the *only* spawn door and concluded that unifying spawn paths "is not the
> work". That was wrong, it was load-bearing, and the plan built on it deleted real work. What
> follows is re-measured.

- `AgentManager.spawn(name, opts)` (`src/agents/AgentManager.ts:1675`) is the door for *starting a
  named agent*, and every such caller does go through it — Bridge `spawn_agent`
  (`src/bridge/tools.ts:1866`), pipeline (`Workspace.ts:2499`), schedules (`Workspace.ts:5795`),
  `continue_task` (`Workspace.ts:3789`), handoff distillation, the Activity-logged UI start.
- **`commitFork` is a second implementation.** It creates its session directly —
  `createForkSession = () => this.opts.tmux.newSession({…})` (`:4726`) — and there is no call to
  `this.spawn` / `spawnUnlocked` / `spawnCore` anywhere in `:4540-4760`. It re-does what spawnCore
  does: env merge, identity mint (`mintExecution`), session-ownership wrapping, Pi admission. Its own
  comment concedes the parallel — *"Merged last for the same reason as spawnCore"* — which is a
  statement about copying that reasoning, not about reusing that code.
- The two other `tmux.newSession` calls (`:3685`, `:3691`) are NOT a third door: both sit inside the
  one low-level create/replace helper that spawnCore itself calls. Precision matters here in both
  directions — the fork finding stands, and inflating it to "three doors" would be the same failure
  in the opposite direction.

**Consequence: unifying the spawn path is real work, and fork is where it bites first**, because it
is the path that already diverges. An `Agent Instance` abstraction that does not cover fork would be
unified in name only.

Sharper still, and directly relevant to invariant 5: the fork path hardcodes `declared: false`
(`:4731`) when it writes session ownership. So **forking a Saved agent produces a row stored as
ad-hoc**, regardless of what the source was. That is the storage-vs-identity conflation this SDD
names, sitting in production code — a much better grounded example than the one the first draft
invented.

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

### Durability: ad-hoc keeps its lineage, DECLARED is the one that drops it

> **CORRECTED 2026-07-29 after adversarial review.** The first version of this section had the sign
> INVERTED: it claimed a Temporary agent's lineage does not survive a restart. The opposite is true,
> and an entire phase of the plan was aimed at that non-problem.

`SessionLedger` (`src/resume/SessionLedger.ts`) persists `def` for every ad-hoc agent (`:136-137`)
and `rehydrateFromLedger()` restores it, so a Temporary agent survives an extension restart. That
part was right.

The parent edge, re-read:

```ts
// src/resume/SessionLedger.ts:484
function stripDeclaredParent<T extends SessionRecord>(rec: T): T {
  if (!rec.declared || !rec.def?.parent) return rec;   // ad-hoc: returns UNCHANGED
  const { parent: _parent, ...def } = rec.def;          // declared: parent dropped
  return { ...rec, def } as T;
}
```

It strips only when `declared` is **true**. So:

- **ad-hoc** — `parent` is persisted, and `rehydrateFromLedger` rebuilds `this.lineage` from it
  (`AgentManager.ts:1229-1230`). Lineage IS durable.
- **declared** — `parent` is deliberately dropped, so a Saved agent has no persisted parent by design.

The in-memory `lineage`/`delegators` maps (`:888`, `:892`) are therefore a CACHE that is refilled from
the ledger for ad-hoc rows, not the only copy.

**There is consequently no "durable lineage" defect to fix**, and the first draft's phase 1 has no
target. The honest statement is narrower: lineage durability is *asymmetric by design*, and the
unified model has to decide whether that asymmetry survives — which is a question for the human, not
a bug for an implementer.

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

### The canonical transaction the creation door must reuse — verified, not assumed

The SDD's hardest requirement is `t-5e1113`'s "commit atômico de profile + authority + roster …
falha compensa/rollback sem estado parcial". That was asserted before it was measured; it is now
measured, and the machinery is stronger than the assertion.

`commitAgentProfileLifecycle` (`src/config/agentProfileLifecycle.ts`) is a journaled phase machine,
not a sequence of writes:

```
intent → staged → profile-published → authority-published → locator-written → activated → committed
                                   ↘ compensating → (clean rollback) | degraded
```

- every phase transition is written to an on-disk journal in a transaction directory (`transition(txDir, …)`);
- `compensate()` (`:506`) restores each durable artifact and the comment at `:539` states the bar —
  "every durable artifact is restored by this point, so the rollback has already succeeded";
- an interrupted transaction is finished on re-read: `if (reread.phase !== "committed") await compensate(…)` (`:636`),
  which is what makes a crash mid-commit recoverable rather than a partial world;
- the authority is re-signed over the PROFILE, not over the staged artifact (`:44`) — so a swapped
  artifact cannot inherit a signature;
- `degraded` exists as a distinct terminal state, so "we could not even roll back" is nameable rather
  than silently indistinguishable from success.

**Consequence: phase 4 must not invent a transaction.** The atomicity, the compensation and the
crash-recovery the creation door needs already exist and are already journaled; the door's job is to
arrive at this entry point with a human-approved, digest-bound payload. Any second write path to
authority would be strictly worse than what is already here, and would be the exact duplication this
SDD exists to reduce.

## What this measurement changes about the proposal

> Rewritten 2026-07-29 after the two corrections above.

1. The migration's spawn-port steps **stay in scope**. There is one door for starting a named agent
   and a second, parallel implementation in `commitFork`; converging them is real work, and fork is
   the first place a unified Agent Instance breaks.
2. The definition-store split (`declared` doing double duty as storage and identity) stands
   unchanged — and `commitFork`'s hardcoded `declared: false` is the concrete instance of it.
3. There is **no durable-lineage defect**. Lineage is durable for ad-hoc and deliberately dropped for
   declared. What replaces that phase is a decision for the human: does the unified model keep that
   asymmetry, and if not, which way does it resolve?
4. The governed creation door is unchanged by all of this: entirely new surface, all of the security
   weight, still severable.

**Process note, kept deliberately.** Two of this document's measured claims were wrong, one of them
inverted, and both were used to *delete* work rather than to add it — the direction of error that
review is least likely to forgive and most likely to be flattered into accepting. They were caught by
adversarial review reading the same code. The lesson recorded here for the next author: a measurement
that conveniently shrinks the plan deserves the same scrutiny as one that grows it.


## The third axis, found while converging readers (phase 3, 2026-07-29)

Converging Fleet reader-by-reader — instead of in the batch the plan forbids — surfaced something the
ratified model does not have a field for.

Not every `declared` read is an identity or lifetime question. Two of Fleet's are asking a THIRD
thing: **was this instance given full lifecycle hooks?** That is decided by `withSessionOwnership`'s
`ownershipOnly`, and it is the same flag `commitFork` sets deliberately, with the comment "a canonical
fork is still an ad-hoc sibling, so it must not inherit profileLifecycle authority".

- `persistenceHooks` — shown only where the persistence hooks were injected.
- `continuity` — the badge exists only where the continuity-pointer hook was injected.

Today `!declared` and `isTemporaryInstance` agree on both, because every instance that lacks lifecycle
hooks also happens to be temporary. **That agreement is a coincidence of the current write paths, not
a meaning.** Converting these two would be right for the wrong reason and would break silently the
day the axes diverge — which is exactly what the promotion path in ratified decision 2
(Temporary → Saved) would do, since a promoted agent gains a Profile while its already-running
instance was launched with ownership-only hooks.

So they are deliberately NOT converted, and the code says why at each site rather than leaving a
future reader to rediscover it.

**RESOLVED by the human, 2026-07-29 (`j-20febbd260be`), and not by adding a field.** Promotion
Temporary → Saved does **not mutate the live instance**: approval creates the Saved Profile, while the
running execution keeps the identity, hooks and policies it was launched with. Only the NEXT instance
is born Saved, with hooks, continuity and full lifecycle. `Restart as Saved` becomes a separate,
visible action, and the UI is expected to show the "promoted, still running as Temporary" condition.

That ruling removes the HYBRID STATE — an instance whose hooks contradict its identity mid-life. It
does not, however, make hooks a consequence of identity, and I briefly implemented it as though it
did: I converted both reads to `isTemporaryInstance`. That was corrected in the same phase.

**Hooks are modelled as a declared CAPABILITY of the instance (`instance.lifecycleHooks`), read and
never derived.** The reasoning is the same one this SDD keeps arriving at: deriving would be sound
today and would still be a derivation, which is precisely what `declared` was before it grew a second
job. And the promotion ruling supplies the case that separates them rather than the one that fuses
them — a promoted agent holds a Saved Profile while its RUNNING instance keeps the ownership-only
hooks it launched with. `identity: "saved"` with `lifecycleHooks: false` is a real, reachable row, and
a derivation would answer it wrong.

Remaining from that decision, NOT implemented here: the UI affordance itself — surfacing "promoted,
running as Temporary" and offering `Restart as Saved`. That is a new capability rather than a reader
convergence, so it belongs in its own slice.
