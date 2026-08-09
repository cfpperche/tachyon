# 484 — governed-delegation-worktree — plan

_Drafted from `spec.md` on 2026-08-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

The creation path already exists and is reached by `parent && worktree === true`. The work is not to
build it — it is to make the four states that open around it defined, and to stop two refusals from
lying about the way out.

Four changes, smallest first:

1. **Lift the Bridge refusal** (`src/bridge/tools.ts:1462`) for `isTemporaryAiAgent && worktree === true`,
   and make its message caller-aware the way `0ac7a71e` made the cwd refusal caller-aware. Today it
   offers "spawn top-level", which an agent caller cannot do.

2. **Give a Temporary child a per-spawn branch identity**, so the adoption path can never fire for it.

3. **Carry the worktree into `forgetAgent`'s cleanup**, so dismiss removes it.

4. **Make the preserved-on-failure checkout visible**, rather than deleting it.

Nothing else. No lease, no store, no authority check — the first non-goal.

## Key decisions

- **A Temporary's branch is unique per spawn; a declared agent's stays name-derived.** Measured:
  `actionForBranchState` (`WorktreeManager.ts:101-113`) maps `exists-free` → **attach**. For a declared
  agent that is the whole point — the branch IS its identity and reattaching is correct. For a
  Temporary it is the defect the adversarial review called a blocker: the second child named
  `codex-residuo` would silently attach to the first one's branch and inherit a stranger's commits
  while its briefing says it starts from main. That is "unknown flattened into known" (`t-b4a799`)
  with a plausible-looking value.

  Chosen because the seam already exists and costs one call site: `branchFor(agent, settings, agentDef)`
  honors `agentDef.branch` FIRST (`WorktreeManager.ts:88`), so passing a computed branch for a Temporary
  needs no new machinery. With a unique branch the state is always `absent` → `create`, and adoption
  becomes unreachable rather than guarded.

  Rejected: *refuse when the branch exists* — turns a stale leftover into a hard block on a name the
  caller may legitimately reuse, and pushes the caller to invent names. Rejected: *attach but warn* —
  a warning does not undo commits the child will build on.

- **A failed isolated spawn PRESERVES its checkout; the fix is visibility, not deletion.** The
  adversarial review asked for "failures clean up what was created". The code disagrees deliberately:
  `rollbackPreparedWorktree` is documented as *"Legacy-named failed-launch hook. Implementations must
  preserve the checkout rather than risk deleting a concurrent ignored write or rewinding a commit
  after a time-of-check/time-of-use gap"* (`AgentManager.ts:612-613`). That reasoning is better than
  the suggestion — deleting a tree that may hold an ignored write is unrecoverable, while a preserved
  tree is merely untidy.

  So the requirement becomes: the preserved checkout must be **findable**. It is registered, and
  `worktree_audit` already reports orphans, so `tasks.md` verifies that surface covers it rather
  than adding a second one.

- **Fail closed when isolation was requested and could not be delivered.** `WorktreeManager.ts:1126-1128`
  notifies and returns `null`, and `null` means the workspace root. For a declared top-level agent the
  root is its home; for a parented Temporary the root is the human's primary checkout. Lines 1121-1125
  already propagate fail-closed when recovery state may exist, so this is narrowing an existing
  asymmetry, not inventing a rule. The discriminator changes from "might we have created state?" to
  "did the caller depend on isolation?".

- **Promotion carries the worktree because everything is keyed on the name — and the risk is the
  declared profile, not the worktree.** `branchFor` derives from the name, the registry entry carries
  `agent: <name>`, promotion rewrites the row to `lifetime: "saved"` keeping the name, and
  `forgetTemporary` clears only lineage. Carry-over is the DEFAULT. The failure mode is a promotion
  whose written profile omits `worktree: true`: then `ctx.worktree` is false, the agent is born
  elsewhere, and the tree is orphaned by omission. Decision: promotion must carry the flag or say it
  is dropping it — the standing rule from `t-da80ed` is that a discarded intent is said out loud.

- **Behavioral criteria over an architectural one.** The first draft required "ONE removal path, and a
  test fails if a second appears". Withdrawn after review: that polices implementation shape, and
  Temporary and Saved genuinely differ (promotion exists for one and not the other). Forcing one
  function would couple two policies — the shape of ceremony this project just removed 26,742 lines of.

## Files touched

| File | Change |
|---|---|
| `src/bridge/tools.ts` | lift the `worktree:true` refusal for a Temporary AI child; make the remaining refusal caller-aware in the shape of `0ac7a71e` |
| `src/worktree/WorktreeManager.ts` | per-spawn branch for a Temporary; fail closed at `:1126` when a parented child asked for isolation |
| `src/agents/AgentManager.ts` | pass worktree removal into `forgetAgent` from `removeEphemeralFootprint`; carry-or-announce on promotion |
| `src/config/agentForget.ts` (or wherever `forgetAgent` lives) | accept a worktree remover, mirroring the Saved Agent cascade's behavior without merging the two call sites |
| `test/unit/spawnParentCwdRefusal.test.ts` | extend the caller-kind pin to the `worktree:true` refusal |
| new test | the five lifecycle states: create, failed create, dismiss, promotion, name reuse |

## Risks & unknowns

- **Where `forgetAgent` should learn about worktrees is not yet read.** Its options object
  (`AgentManager.ts:3543-3548`) takes `removeHarnessHome` / `removePiSessionDir` as injected removers,
  so a `removeWorktree` in the same shape is the likely fit — but the Saved Agent cascade
  (`removeAgentWorktree` → `releaseOwnedWorktreeForRemoval` → `prepareAgentProfileForget`) has three
  occupancy gates that a Temporary dismiss may or may not want. **Verify before writing:** does a
  Temporary dismiss need occupancy checks at all, given the pane is already dead?

- **Uncommitted work on dismiss.** Criterion 3 says the human is told rather than silently losing it.
  The Saved Agent path already computes this for its plan preview; whether that computation is
  reusable without dragging in the whole plan machinery is unverified.

- **`worktreeSetup` cost.** Eleven isolated children can mean eleven dependency installs. No quota is
  being added (see spec), but `tasks.md` should measure one real isolated spawn end-to-end so the cost
  is known rather than assumed.

- **Not proven: that these five states are all of them.** The review was right that "the only gap" was
  a claim larger than the evidence. Crash-during-create and extension reload were named and not
  measured. Treat any sixth state found during implementation as in scope, not as a follow-up.

## Visual impact

None. This is a Bridge/lifecycle change with no rendered surface; the sidebar already renders agents
that have worktrees.

**Visual QA Opt-Out:** no user-visible surface changes — the agent row and worktree list already
render isolated agents today, and this spec adds no new view, control or layout.

## Sources consulted

- `src/worktree/WorktreeManager.ts` — `resolveSpawnCwd` (`:1052-1140`), `branchFor` (`:87-95`),
  `actionForBranchState` (`:101-113`), `validateReuse` (`:120-136`)
- `src/bridge/tools.ts` — `:1440` (cwd refusal, caller-aware since `0ac7a71e`), `:1462` (worktree refusal, not)
- `src/agents/AgentManager.ts` — `:612-623` (rollback/complete hooks), `:2283-2294` and `:2449-2459`
  (failed-launch preservation), `:3521-3570` (Temporary end of life)
- `src/worktree/managedWorktree.ts:14` — `ManagedWorktreeEntry`
- `src/probe/archetypes.ts:55-58`, `src/probe/ProbeService.ts:37,265` — why the first adversarial
  review returned nothing (probe has no tools by design)
- `git show c0d6ed81` (t-f660d8, origin of the cwd rule), `git show 0ac7a71e` (t-5f823a, caller-aware refusal)
- `git show d6789d02^:docs/reports/2026-07-28-parented-adhoc-spawn-cwd.md` — the prior report, removed
  from the tree but recovered from history; its §6.4 prescribed the named-reference shape this spec follows
- Adversarial review, codex `gpt-5.6-sol`, probe `probe-fd604559` — 7 findings, 6 upheld
