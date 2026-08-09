# 484 — governed-delegation-worktree — tasks

_Generated from `plan.md` on 2026-08-01. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Measure first

These are reads, not edits. The plan names them as unverified; writing code before they are answered
is how this spec's first draft earned three blocker findings.

- [ ] Read `forgetAgent` end to end. Does its options shape (`removeHarnessHome` / `removePiSessionDir`
      as injected removers) fit a `removeWorktree` in the same style? Record the answer in `notes.md`.
- [ ] Read the Saved Agent cascade — `removeAgentWorktree` → `releaseOwnedWorktreeForRemoval` →
      `prepareAgentProfileForget`. It has three occupancy gates. **Decide and record: does a Temporary
      dismiss need any of them, given its pane is already dead?** Reusing gates that do not apply is
      the ceremony the first non-goal forbids; skipping ones that do apply is `t-4736b4` again.
- [ ] Find where a promotion writes the declared profile, and whether `worktree: true` can be carried
      into it. If it cannot, the honest outcome is announcing the drop, not silently orphaning.
- [ ] Confirm `worktree_audit` reports a checkout preserved by a failed launch. If it does not, that
      gap — not deletion — is what closes criterion "failed create".

## Implementation

- [ ] Give a Temporary child a per-spawn branch, passed through the existing `agentDef.branch` seam
      (`WorktreeManager.ts:88` honors it first). Declared agents keep name-derived branches unchanged.
- [ ] Lift the `worktree: true` refusal for a Temporary AI child (`src/bridge/tools.ts:1462`).
- [ ] Make that refusal's surviving branches caller-aware, in the shape `0ac7a71e` used for the cwd
      refusal — an agent caller must never be offered "spawn top-level".
- [ ] Fail closed at `WorktreeManager.ts:1126-1128` when a PARENTED child asked for isolation: the
      workspace root is the human's checkout, not a fallback. Leave the top-level path unchanged.
- [ ] Carry worktree removal into `removeEphemeralFootprint`'s `forgetAgent` call.
- [ ] Carry-or-announce the worktree on promotion.

## Verification

_Acceptance checks tied to `spec.md`. Each maps to a scenario there._

- [ ] An agent caller spawning with `cmd` + `worktree: true` gets a registered worktree, not a refusal.
- [ ] Dismiss removes the worktree and its registry entry; recoverable work is reported, not destroyed.
- [ ] Promotion keeps the worktree; a promotion that would relocate the agent says so.
- [ ] A parented isolated spawn that cannot get a worktree FAILS — it does not start at the workspace root.
- [ ] Re-spawning a Temporary name never lands in the previous child's branch or checkout.
- [ ] The `cwd` refusal and its existing test are untouched.
- [ ] Every exit named by both refusals is executable by an agent caller — pinned against `resolveActor`,
      extending `test/unit/spawnParentCwdRefusal.test.ts` rather than adding a parallel guard.
- [ ] Mutation check, the standard this project holds: reintroduce the broad refusal and the
      name-derived Temporary branch, and confirm each turns a specific test red.

**Headless check:** `npm run typecheck && npx vitest run test/unit/spawnParentCwdRefusal.test.ts test/unit/agentManager.test.ts test/unit/worktreeManager.test.ts --reporter=dot`

**Verify:** `npm run typecheck`

## Dogfood

The real dogfood is the incident that opened this spec: a coordinator could not hand work to a child
in an isolated checkout, and fell back to five Claude Code subagents that die with their parent.

**Dogfood:** `npx vitest run test/unit/spawnParentCwdRefusal.test.ts --reporter=dot`

**Human dogfood:** the coordinator agent spawns one Temporary child with `worktree: true`, confirms it
lands in its own checkout on its own branch, dismisses it, and confirms the worktree and its registry
entry are gone — the same four-authority check that closed `t-e722ce` by hand on 2026-08-01
(`tachyon.yml`, `.tachyon/agents/`, `sessions.json`, `managed-worktrees.json`).

## Visual QA

**Visual QA Opt-Out:** no user-visible surface changes. The sidebar and worktree list already render
agents that own worktrees; this spec adds no view, control, or layout.

## Cookbook

**Cookbook:** yes

`spawn_agent` gains a usable capability for every coordinator, and the two refusals that currently
block it are the first thing an operator meets. A short how-to — when to isolate, when to inherit, how
work moves between children by branch rather than by shared tree, and what dismiss takes with it — is
what stops the next coordinator from rediscovering this by trial and error, which is exactly how this
spec was born.
