# 484 — A delegated child may be born in its own worktree

_Created 2026-08-01._

**Status:** draft

Task: `t-d06da3` (the blocked follow-up of `t-5f823a`).

## Intent

An agent cannot delegate work into an isolated checkout. Every door is closed, and two of them close
by naming an exit the caller cannot take.

Measured on 2026-08-01 while trying to hand five bugs to five children:

| Attempt | Outcome |
|---|---|
| `spawn_agent(cmd, cwd, parent)` | refused — `PARENT_CWD_REFUSAL` |
| `spawn_agent(cmd, cwd)` without parent | refused — the SAME message; an omitted parent resolves to the caller (`resolveActor`, `src/bridge/callerIdentity.ts`) |
| `spawn_agent(cmd, worktree: true)` | refused — `src/bridge/tools.ts:1462`, "declare the agent in tachyon.yml, or spawn top-level" |

The third refusal names two exits. The first requires editing workspace config once per delegation.
The second — "spawn top-level" — is unavailable to an agent for exactly the reason the cwd refusal's
exit was: an agent caller always resolves a parent. `t-5f823a` fixed that lie in the cwd refusal on
2026-08-01 and did not reach this one, because the fix was written for one message.

So the coordinator's only remaining option is to let the child run **in the parent's own worktree**,
which is strictly less contained than the thing being refused. That is the state this spec ends.

### What the refusals protect, and why it does not apply here

`c0d6ed81` (t-f660d8) records the intent: a parented child's cwd is decided by `resolveWorktreeCwd`,
so an explicit `cwd` would be *silently discarded*. The refusal converts "ignored" into "refused" —
an **honesty control, not a containment control**. Confirmed twice: a parented child is refused even
when the requested `cwd` is exactly what it would inherit, and a non-parented spawn accepts any
existing directory on nothing but `existsSync`.

That argument justifies refusing an explicit `cwd`, and **only that**. It never justified refusing
`worktree: true`, which names no path at all: there is no supplied value to discard, so an honesty
control has nothing to protect. Criterion 5 below keeps the `cwd` refusal exactly as it is — the two
are different APIs with different semantics, and this spec touches only the second.

### The machinery already exists

`resolveSpawnCwd` (`src/worktree/WorktreeManager.ts`) branches on `ctx.parent && !ctx.worktree` for
inheritance and falls through to worktree creation otherwise. Its own docstring states the contract:
*"sub-agent (parent set): inherit the parent's cwd unless `worktree:true` opts into its own
worktree."* The resolver already does this. Only the Bridge refuses to let a Temporary child ask.

The resolver reaching the creation path is NOT the same as the feature working, and an adversarial
review (2026-08-01, codex) was right to refuse that shortcut. Everything on that path is keyed on the
agent NAME — `branchFor(ctx.name, …)` and `ensure({ agent: ctx.name, prior: … })` — and a Temporary
name is reusable. Whether a second spawn of the same name adopts, refuses, or collides with the first
one's leftovers is a **correctness condition of this proposal**, not a detail to settle later.

Done looks like: an existing parameter stops being refused, and every lifecycle state that opens when
it stops being refused is defined — successful create, failed create, dismiss, promotion, name reuse.
The spec does not claim to know that list is complete; it claims those five are mandatory.

## Acceptance criteria

- [ ] **Scenario: an agent delegates into an isolated checkout**
  - **Given** a coordinator agent with a running session
  - **When** it calls `spawn_agent` with a runtime `cmd` and `worktree: true`
  - **Then** the child is created in its own git worktree on its own branch, registered in
    `.tachyon/managed-worktrees.json`, and the call is not refused

- [ ] **Scenario: dismissing the child takes its worktree with it**
  - **Given** a Temporary child that was born in its own worktree
  - **When** it is dismissed (Bridge `dismiss_agent`, or the UI's dismiss)
  - **Then** the worktree and its registry entry are gone, through the SAME cascade a Saved Agent's
    forget uses — not a second cleanup machine

- [ ] **Scenario: unmerged work is not destroyed on the way out**
  - **Given** a dismissed child whose worktree holds uncommitted or unmerged commits
  - **When** the dismissal runs
  - **Then** the human is told what would be lost, rather than it being removed silently

- [ ] **Scenario: promotion keeps the worktree instead of orphaning it**
  - **Given** a Temporary child running in its own worktree
  - **When** it is promoted to a declared agent (the ledger row becomes `lifetime: "saved"`)
  - **Then** the same worktree stays its working directory — it is not orphaned and no second one
    is created
  - **And** if the declared profile would place the promoted agent elsewhere, the promotion says so
    rather than silently leaving a worktree behind

- [ ] **Scenario: an isolated child that cannot be isolated does not fall back to the human's checkout**
  - **Given** a parented child spawned with `worktree: true`
  - **When** the worktree cannot be created (no-git / not-repo / unborn / bare / add-fail)
  - **Then** the spawn fails closed with the reason, and the child is NOT born at the workspace root

- [ ] **Scenario: the refusals name an exit the caller can take**
  - **Given** an agent caller
  - **When** it supplies an explicit `cwd`
  - **Then** the refusal names `worktree: true`, and every exit it names is one an agent caller can
    execute — pinned against `resolveActor`, the way `t-5f823a` pinned the cwd refusal

- [ ] **Scenario: a name reused across spawns does not inherit the last one's tree**
  - **Given** a Temporary child was spawned isolated, finished, and its name is spawned again
  - **When** the second spawn runs
  - **Then** the outcome is defined and tested — adoption, refusal or a fresh identity — and never a
    silent landing in the previous child's leftover checkout or branch

- [ ] Explicit `cwd` for a parented child is still refused, and its existing test is unchanged.
- [ ] No lease, no new store, and no new authority check are introduced by this spec.
- [ ] Dismiss and forget each remove the CORRECT worktree, preserve recoverable work, and leave the
      registry consistent. These are behavioral criteria; whether one helper or two implement them is
      an implementation choice, not an acceptance criterion.

## Non-goals

- **No lease, no contract ledger, no authority store.** Delivery was 26,742 lines of exactly that and
  was removed on 2026-08-01. Anything this spec adds beyond a parameter and a cleanup path repeats
  the mistake.

- **Entering another agent's worktree is out of scope, and is not deferred debt — it is
  unnecessary.** Worktrees of one clone share refs, so an agent takes over another's work with
  `git merge <their-branch>` from its own tree; merging a ref is not a checkout, so git does not
  refuse it. Reviewer, second implementer and recovery are all served this way. Two trees never
  touch, so concurrency control has nothing left to control. Proven in practice on 2026-08-01: five
  agents, five worktrees, work moved by branch, zero collisions between trees.

  Accepted limit, stated rather than solved: **uncommitted work does not travel.** That is the right
  limit. It makes "commit before handing off" a rule instead of a hope, and the alternative —
  entering a live tree to rescue dirty files — is precisely where two agents corrupt each other.

- **Explicit `cwd` stays refused.** A raw path is still ungoverned. This spec gives the existing
  refusals a true exit; it does not open a second one.

- No change to `maxAgents`, to the delegation contract, or to who may spawn.

## Open questions

**Authorization — resolved 2026-08-01 by the workspace owner.** Whoever may already spawn a Temporary
child may spawn it isolated. Spawning is already an authorized act carrying a delegation contract and
the `maxAgents` guardrail. Requiring a second authorization for the *more* contained option would push
callers toward the less contained one, which is the failure this spec exists to end. Promoted into the
acceptance scenarios above; recorded here because it was the one fork that was not the author's to
settle.

**One over-claim withdrawn.** The author first wrote that isolation "does not widen what the child may
do, it narrows where it may write". The permission half is true; the COST half was missing. Each
isolated child is a real checkout, and the create path also runs `worktreeSetup` (`WorktreeManager.ts:1099-1108`)
— with `maxAgents: 12`, eleven isolated children can mean eleven dependency installs. No quota is
added here: the agent cap already bounds the count transitively, and inventing a worktree quota on top
would be the ceremony the first non-goal forbids. What IS required is that a failed spawn leaves no
checkout behind — `plan` must confirm `rollbackPreparedWorktree` already covers that rather than
assume it.

**Branch naming — answered by the code, and it was the wrong question.** `WorktreeManager.ts:1088`
calls `branchFor(ctx.name, deps.settings, { branch: ctx.branch })`, the same template a declared agent
uses. So a Temporary child takes `tachyon/{name}` and shares one namespace with declared agents. The
open question is not the template, it is **name reuse**: a Temporary name may repeat across spawns,
and `ensure()` receives `prior: deps.priorRecord`. What the second spawn of a same-named Temporary
does with a leftover branch or checkout is the thing to resolve in `plan`.

**Why promotion is nearly free, and where it is not.** Everything is keyed on the agent NAME:
`branchFor` derives from it, the registry entry carries `agent: <name>`, and promotion keeps the name
while rewriting the row to `lifetime: "saved"`. `forgetTemporary` clears only lineage, so a promoted
agent becomes top-level and `ensure()` re-finds its prior record. Carry-over is therefore the DEFAULT
behavior, not a feature to build — which is exactly why it needs a pinning test rather than trust.

The trap the acceptance criterion exists for: carry-over holds **only if the declared profile also
says `worktree: true`**. Promote without it and `ctx.worktree` is false, the agent is born elsewhere,
and the worktree is orphaned by omission rather than by decision. Resolve in `plan` whether promotion
should carry the flag automatically or refuse to promote silently — the workspace owner's standing
rule is that a discarded intent must be said out loud (`t-da80ed`).
