# 484 — governed-delegation-worktree — notes

_Created 2026-08-01._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

**The probe archetype cannot review code, and that is by design.** The first adversarial review of this
spec was requested as `probe_agent(runtime: "codex", archetype: "adversarial-review")` pointed at the
spec file. It came back a single `blocker` finding: every verdict INCERTO, because it "was forbidden
to inspect the filesystem, run commands, or use tools." That is correct behavior, and the cause is
`src/probe/archetypes.ts:57`, whose brief says verbatim: *"or use tools. Base your answer only on the
TASK, CONTEXT, and CONSTRAINTS below."*

So `probe_agent` is a **context-only reasoner**, not a code inspector. `write: true` buys an isolated
cwd (`ProbeService.ts:37`, `:265` — `sandbox: workspace-write` vs `read-only`), which is about where
it may write, not whether it may read. For adversarial review OF CODE, the right instrument is a
spawned agent with tools (as `codex-revisor` was for t-21101f); for adversarial review of an ARGUMENT,
a probe works — provided the material is pasted into the context.

Recorded here because the misuse cost a round trip and the distinction is not obvious from the tool
description, which says "captured A2A duet" without stating that the duet has no hands.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

### Self-review findings, before the second probe returned

Three things the author found by re-reading the code after writing the spec. Recorded before the
adversarial verdict so it is visible which were caught in-house and which needed a second model.

**1. Failure of worktree creation drops the child into the workspace ROOT.** `WorktreeManager.ts:1126-1128`
— an ordinary `WorktreeUnavailableError` notifies and returns `null`, and `null` means the AgentManager
uses the workspace root. For a *declared top-level* agent that is defensible: the root is its normal
home. For a **Temporary child that explicitly asked for isolation, the root is the human's primary
checkout** — strictly worse than the status quo, where the child would at least land in the parent's
worktree.

Note that lines 1121-1125 already fail closed for the cases where a checkout may have been left
behind. The distinction being drawn there is "did we possibly create state", not "did the caller
depend on isolation". This spec needs an acceptance criterion that a parented child which asked for
isolation and did not get it **fails closed**, and must argue why that differs from the top-level
case rather than just asserting it.

**2. Promotion is an uncovered lifecycle.** `AgentManager.ts:3521` + its docstring: a Temporary can be
promoted to a declared agent (`lifetime: "saved"`). The spec enumerates dismiss and says nothing about
promotion. If a Temporary with its own worktree is promoted, does the worktree carry over as the
declared agent's owned worktree, or does the declared agent get a second one and orphan the first?
`branchFor` derives from the agent NAME, so the branch may in fact be identical — which would make
carry-over the natural answer, but that must be verified rather than assumed.

**3. The open question about branch naming is already answered by the code, so the spec should not
have deferred it.** `WorktreeManager.ts:1088` calls `branchFor(ctx.name, deps.settings, {branch: ctx.branch})`
— the same template a declared agent uses. So a Temporary child would take `tachyon/{name}` and share
one namespace with declared agents. The real question is not "what template" but **name reuse**: a
Temporary name can repeat across spawns, and `ensure()` receives `prior: deps.priorRecord`. What the
second spawn of a same-named Temporary does with a leftover branch or checkout is the thing to
resolve, and it is a sharper question than the one the spec wrote down.

## Measure-first results (2026-08-01, before any implementation)

The four reads `tasks.md` demanded ahead of code. Three of them changed the plan.

**1. `forgetAgent` cannot host worktree removal, and the reason is shape, not policy.**
`src/agents/forgetAgent.ts:33-50` is synchronous (`: void`) and every injected remover is a sync call
(`deps.removeHarnessHome?.(name)`). Removing a git worktree spawns git and is async. So a
`removeWorktree` dep in the same style does not fit — the whole function would have to become async,
and its callers with it.

This retroactively vindicates the adversarial review's objection to the withdrawn "ONE removal path"
criterion: the two lifecycles differ in *nature*, not merely in policy. Worktree removal belongs at
the dismiss CALL SITE, which is already async, not inside the sync footprint sweeper.

**2. The shared cascade already exists, and the Bridge is a third door that skips it.**
`src/engine-service/extensionOperationService.ts:940` already runs
`if (record?.worktree) await removeAgentWorktree(workspace, agent, true)` before dismissing — and it
is GENERIC, not Saved-specific. `src/agents/agentRemovalCascade.ts` exists precisely for this; its
docstring (from `t-e722ce`, today) says it was extracted "so BOTH doors can call the same code instead
of two copies drifting".

`src/bridge/tools.ts:1612` calls `deps.manager.dismissTemporary(name)` directly, with no worktree step.

So the fix is not a new cascade — it is the Bridge door calling the one that already exists. Today
this is invisible because a Temporary cannot own a worktree; enabling that turns it into `t-33ae3f`
for the third time. Note the irony worth keeping: the module written today to stop two doors from
drifting has a third door that never called it.

**3. Promotion orphans the worktree by omission — confirmed, not suspected.**
`promoteAgent` (`extensionOperationService.ts:957-989`) writes the tachyon.yml entry through
`addAgent(text, agent, definition.cmd, "terminal")` — cmd and kind ONLY. No worktree flag. So a
promoted agent's declared profile says nothing about isolation, `ctx.worktree` resolves false on its
next launch, and the tree it was using is stranded. The spec's carry-or-announce criterion is
therefore load-bearing, not defensive.

**4. Hygiene visibility of a preserved checkout — PARTIAL, verify during implementation.**
`classify.ts` classifies a `ManagedWorktreeEntry`, i.e. a REGISTERED worktree. A launch that fails
after `git worktree add` succeeded should therefore still be registered and visible. But whether the
failure path leaves the registry entry in place, or rolls it back and leaves an unregistered directory
on disk, was not established by reading alone. **Do not assume**: the implementation must prove it,
because an unregistered preserved checkout is invisible debt — the exact thing criterion "failed
create" exists to prevent.

## Measured during implementation (2026-08-01)

**4 — ANSWERED, and the answer is that the preserved checkout IS visible.** The fourth read was left
PARTIAL because reading could not settle whether the registry row survives a failed launch. Measured
end to end on a real git repository (`workspaceHeadless.test.ts`, "leaves the checkout preserved AND
registered"): a real isolated launch whose `tmux new-session` fails after `git worktree add` has
already succeeded rejects with `agent worktree recovery state was preserved instead of automatic
cleanup` — and the checkout is BOTH on disk and still in `.tachyon/managed-worktrees.json`. Two
mechanisms make that so, and both are deliberate: `Workspace.resolveSpawnCwd` calls
`syncAgentRecord` the moment the resolver hands the record back — before the HEAD probe, before any
launch step can fail — and `rollbackPreparedWorktree`'s implementation states "Registry rows stay
active so reveal still points at the recovery path". So `worktree_hygiene`, which classifies
registered entries, sees the debt. Verified by mutation: deleting that `syncAgentRecord` call turns
the test red with an empty registry, which is exactly the invisible-debt state the criterion exists
to prevent.

One window remains and is narrower than it looks: a throw BETWEEN `git worktree add` succeeding and
`resolveWorktreeCwd` returning (quarantine-lock failure, branch/HEAD drift under the lock, an
unresolvable HEAD, or a `runSetup` failure) never reaches the registration line, so the preserved
checkout would be unregistered. For the case this spec opens it is not reachable through setup: a
Temporary's def carries no `worktreeSetup`, and a Saved profile's `workspace.worktree.setup` is
refused by projection ("verification/setup references are not materialized yet"). What is left are
git-level anomalies, whose error message names the recovery path. Recorded rather than fixed —
closing it means either widening hygiene to scan `git worktree list` or teaching the resolver to
register before it can fail, and both are larger than this spec.

**Occupancy gates on the Bridge dismiss — decided by measuring what each one is for.** The Saved
cascade's gates all apply and arrive with `removeAgentWorktree`: `liveDescendants` (the one that
matters most HERE — a parented child with no `worktree:true` runs in its parent's cwd by
construction, so this is the only lifecycle that can put a live agent inside the checkout being
removed), the measured `probeAgentOccupancy` gate (the door's own `running` flag comes from
`manager.list()`, the stale snapshot t-4736b4 found lying in both directions), and
`releaseOwnedWorktreeForRemoval`'s ownership check. The engine door's extra
`stopAgentSessionForDelete` is NOT reused: on this path it is a second run of the probe → kill →
re-probe the cascade just did, and for an entry with no checkout it would add a new way for a dismiss
that works today to refuse when tmux is slow.

**What criterion 3 still does not cover.** `removeAgentWorktree` passes `deleteBranch: true`, and
`WorktreeManager.remove` deletes with `git branch -d`, so a branch holding unmerged commits survives
— the dismiss now says so, in the reply and in a warn notice. Uncommitted FILES are a different
story: `remove()` defaults to `force: true` for legacy/internal callers, so a dirty checkout is
force-removed. That is unchanged from the engine door and is the shared cascade's behaviour, not this
door's; narrowing it would change both doors and belongs to its own task.
