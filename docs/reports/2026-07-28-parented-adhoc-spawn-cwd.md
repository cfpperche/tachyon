# `spawn_agent` + `parent` + `cwd` — why it is refused, and what to do about it (t-e787dc)

_Measured 2026-07-28 against `main` `e4de906f`, in the change worktree `tachyon/change/t-e787dc-parented-cwd-report`.
Nothing in the product was modified: this report is the deliverable. Every `file:line` below was read
at that commit, not inferred._

---

## 1. The rule has a recorded origin, and it is not the one the task assumed

`git log -S` on the refusal text lands on one commit:

**`c0d6ed81` — `fix(t-f660d8): declared spawn primer provenance and cwd contract`** (2026-07-16), which
added both the guard and its test in the same change. Its message states the contract:

> Explicit cwd is applied for non-parented launches or rejected clearly (missing dir, worktree
> conflict, parented ad-hoc).

The comment above the guard (`src/agents/AgentManager.ts:2119-2122`) gives the reason in the product's
own words:

> t-f660d8 — explicit spawn_agent cwd: honor or fail closed (never silently ignore).
> Parented ad-hoc children inherit the parent's cwd via resolveWorktreeCwd — refuse opts.cwd
> so callers never think a custom path was applied.

**So the prohibition is not a security control. It is an honesty control.** A parented child's cwd is
decided by `resolveWorktreeCwd`, which for `parent && !worktree` returns the parent's cwd
(`src/worktree/WorktreeManager.ts:944-947`). An explicit `cwd` would therefore be *discarded*, and the
caller would have no way to know. The refusal converts "silently ignored" into "loudly refused".

That reframes the risk assessment the task asks for: workspace escape and Delivery confusion are
consequences of **permitting** a cwd, not the reasons it was **forbidden**. They have to be argued on
their own merits, which §4 does.

A second, independent trace confirms the rule was applied deliberately rather than inherited: spec
376's notes (`docs/specs/376-retire-legacy-delivery/notes.md:82-84`) record that a stale fixture
"expected parented ad-hoc `cwd` to be accepted despite the newer fail-closed contract", and that the
*test* was corrected to match the contract — not the contract relaxed to match the test.

Today the rule is pinned by `test/unit/agentManager.test.ts:6273` (`t-f660d8: parented ad-hoc with
explicit cwd fails closed`).

## 2. What the guard actually does

`src/agents/AgentManager.ts:2123-2141`, in order:

| # | Condition | Outcome |
|---|---|---|
| 0 | `forced` (a canonical Delivery launch) | **The guard is skipped entirely** — Delivery supplies `cwd` and `worktree` directly (`:2091-2093`) |
| 1 | `cwd` missing or not a directory | refuse: `cwd is not an existing directory` |
| 2 | `parent` set | refuse: `not used for parented ad-hoc children` |
| 3 | child has its own `worktree` and the paths differ | refuse: conflict |
| 4 | otherwise | `cwd = requested` |

Two things follow that are easy to miss:

- **Branch 2 preempts branch 3 unconditionally.** A parented child is refused even when the supplied
  `cwd` *exactly matches* the worktree that would be used. The refusal is about provenance, not about
  disagreement, so "the value was right" never gets a chance to matter.
- **Branch 0 is the interesting one.** The product already has a path where an agent is launched into
  a specific, pre-existing checkout: the Delivery-bound launch, which hands `cwd` and `worktree` in
  directly and bypasses this guard. The ungoverned `cwd` string and the governed Delivery launch are
  not two spellings of one feature — they are a raw path versus a path that arrives with ownership.

## 3. Trust and ownership around a parented spawn

Measured, because the recommendation depends on it:

- **cwd inheritance reads durable record, not the live process.** `parentCwd` is
  `ledger.get(parent)?.worktree?.path ?? ledger.get(parent)?.cwd`
  (`src/workspace/Workspace.ts:1253-1256`). A parent that is not in the ledger yields `undefined`,
  `resolveWorktreeCwd` returns `null`, and the child is born at the **workspace root** — silently.
  That is a real inconsistency: the product refuses an explicit path in the name of not misleading the
  caller, while a missing parent record quietly relocates the child to the root.
- **A gated delegation deliberately drops the parent for cwd purposes.** `parent: ctx.gate ? undefined
  : ctx.parent` (`src/workspace/Workspace.ts:1247`), so a gated child gets its own worktree rather
  than inheriting. Inheritance is the *ungated* case's rule.
- **`worktree: true` cannot be the escape hatch for an ad-hoc child.** The Bridge refuses it outright:
  "worktree:true is not a tracked-change lifecycle for an ad-hoc AI agent; use gate with a
  behavior_test and owned paths" (`src/bridge/tools.ts:1681-1685`).
- **There is already a first-class door for "run in an existing managed worktree": `delivery_join`.**
  The tool's own description says so — "Use delivery_join to run a later implementer, reviewer, fixer,
  or recovery segment in a canonical Delivery's existing worktree" (`src/bridge/tools.ts:1586`) — and
  it is authorization-checked: the caller must be the Delivery's creator, or human/master
  (`:1753-1759`). It composes with `parent`, and it refuses to combine with `gate`/`worktree:true`
  because "a Delivery already owns its worktree" (`:1654-1656`).

  **And it genuinely reaches that worktree rather than inheriting the parent's cwd** — checked, because
  the recommendation rests on it: `spawnDeliveryJoin` prepares the Delivery and calls
  `spawnCore(name, opts, { cwd: prepared.cwd, worktree: prepared.worktree, … })`
  (`src/agents/AgentManager.ts:1695-1699`), which is the `forced` path of §2 — the branch that bypasses
  both `resolveSpawnCwd`'s parent inheritance and the `opts.cwd` guard entirely.

## 4. The three options, judged

### A. Keep the prohibition (recommended)

The observed need — "spawn a child into a managed change worktree" — is already served by
`delivery_join`, which supplies the same cwd *with* an owner, a lease, an owned subset and an expected
HEAD. Allowing a bare `cwd` alongside it would add a second way to reach the same place with none of
those, and the two would drift: any future rule about who may run where would have to be written twice
or would apply to only one door.

It also keeps the property the guard was built for. Once `cwd` is honored for a parented child, the
child's cwd and its lineage stop agreeing, and every reader downstream (the sidebar's tree, the
worktree registry, Delivery's containment checks) has to ask which one is true.

### B. Allow arbitrary validated `cwd` (reject)

Validation can prove a path exists and is a directory. It cannot prove the path is *governed* — that
someone owns it, that a Delivery is not mid-flight in it, that two agents are not about to write the
same tree. Those are exactly the questions `delivery_join` and the worktree registry answer. A
validated-but-ungoverned path is the shape of failure spec 444 and SDD 368 were written to close
(worktrees outliving their owners, deliveries with no lease), reintroduced through a different door.

### C. Allow `cwd` only inside a governed worktree/workspace (reject, with a caveat)

This is the tempting middle, and it is worse than it looks: to check "is this path a governed
worktree", the code has to consult the registry — at which point the caller could have named the
Delivery or the worktree instead of a path, and gotten ownership checks for free. It is `delivery_join`
with a weaker argument type. The caveat: if a need appears for a NON-Delivery managed checkout (a plain
registered change worktree), the right shape is a named reference (`worktree_id`), not a path — see the
follow-up in §6.

## 5. Schema ergonomics — the task's own observation, confirmed

`spawn_agent` declares `parent` and `cwd` as independent optionals with no cross-field refinement
(`src/bridge/tools.ts:1595`, `:1601`), so an incompatible pair type-checks, reaches the manager, and is
refused only at execution — after the caller has composed a full delegation contract. `zod`'s
`superRefine` would move that refusal to the schema, where the error can also name the alternative.

This is worth doing **whatever is decided about permitting cwd**, and it is independent of §4: if the
prohibition stays, the schema should state it; if it were ever lifted, the schema would need the
cross-check anyway to express whatever the new rule is.

The description text needs one correction while someone is there: `worktree` is described as "ignored
for a sub-agent, which shares the parent's worktree" (`:1608`), but the Bridge refuses `worktree:true`
for ad-hoc AI agents outright (`:1681`) — "ignored" and "refused" are different promises, and the
second is the true one.

## 6. Recommendation

**Keep the refusal. Fix where it is delivered, and say what to use instead.**

1. **Move the check into the schema** (`superRefine` on `parent` + `cwd`), so an impossible combination
   is refused before a contract is composed.
2. **Make the message name the alternative.** Today it says what not to do ("omit cwd or spawn without
   parent"); it should also say what to do — `delivery_join` for a Delivery's worktree, or spawn
   top-level when the child genuinely belongs somewhere else. In the observed incident the caller
   worked around the refusal by putting an absolute path in the *briefing*, which is the least
   governed outcome available: the child ran wherever it decided to `cd`, with no record at all.
3. **Close the honesty gap the guard leaves open** (§3, first bullet): a parented child whose parent
   has no ledger record is silently born at the workspace root. The same argument that forbids
   silently ignoring a cwd forbids silently substituting one. It should at minimum notify, in the shape
   `resolveWorktreeCwd` already uses for worktree unavailability.
4. **Do not add `cwd` support for parented children.** If a real need appears for a non-Delivery
   managed checkout, add a *named* reference (`worktree_id`) resolved through the registry, so
   ownership is checked by construction rather than validated after the fact.

## 7. Follow-ups (not implemented here)

| What | Why | Size |
|---|---|---|
| `superRefine` on `spawn_agent` for `parent` + `cwd`, message naming `delivery_join` | moves an execution-time refusal to the schema; §5 | small |
| Correct the `worktree` field description ("ignored for a sub-agent" → refused for ad-hoc AI) | the doc and the guard disagree today; §5 | trivial |
| Notify when a parented child falls back to the workspace root for want of a parent record | closes the same class of silence the guard exists to prevent; §3 | small |
| Document the "run in an existing worktree" door in the runbook/cookbook | the incident shows `delivery_join` is not discoverable from the refusal | small |

The first three are code; each is independently shippable and none changes the contract this report
recommends keeping.
