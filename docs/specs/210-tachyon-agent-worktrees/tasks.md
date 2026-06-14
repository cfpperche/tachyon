# 210 — tachyon-agent-worktrees — tasks

**Verify:** `npm run typecheck && npm test`

## Implementation

- [x] 1. **Config** (`src/config/loadConfig.ts` + schema + nls): parse agent
      `worktree: bool`, `branch: string`, `worktreeSetup: string|string[]`
      (normalize → `string[]`); `settings.worktree.{base, branch}`. Validate branch
      name chars; reject unknown keys. Update `tachyon.schema.json`. Unit-test
      parsing + normalization + branch-char validation.
- [x] 2. **Pure resolvers** (`src/worktree/WorktreeManager.ts`): `resolveBase`
      (XDG `~/.cache/tachyon/worktrees` default ← `settings.worktree.base`),
      `pathFor(wsHash, agent)`, `branchFor` (per-agent > global template{agent} >
      `tachyon/<agent>`; **validate via `git check-ref-format`; reject a global
      template missing `{agent}`**), git-arg builders for add/attach/remove/branch,
      and the **branch-state→action** decision (absent→`-b`+owned / exists→attach+
      not-owned / checked-out-elsewhere→fail) + the **reuse-validation** predicate
      (common-dir==repo && on-expected-branch). Unit-test all (no real git).
- [x] 3. **Git side** of WorktreeManager (LOCKED per agent): `ensure` (prune →
      validateReuse → create per the matrix; record `{path,branch,
      tachyonCreatedBranch,baseRef,createdAt}`), `status(cwd, baseRef)` (dirty
      staged/unstaged/untracked/conflicts + `aheadOfBase`/`unpushed`/`detached`),
      `canRemove(agent)` (no live descendants), `remove(rec, deleteBranch)`
      (`git worktree remove --force`; `branch -D` ONLY when `tachyonCreatedBranch`).
      Integration test on a tmp repo: create / reuse-valid / reuse-rejected
      (branch drift) / branch-exists-not-checked-out / branch-checked-out-elsewhere
      / dirty / ahead / human-branch-not-deleted / remove.
- [x] 3b. **Persist `WorktreeRecord`** (extend `SessionLedger` or sibling store) so
      cleanup + C2 read real path/branch/ownership, never recompute from config.
- [x] 4. **Spawn cwd resolution** (`Workspace` + `AgentManager`): top-level +
      `worktree:true` → `ensure` then run `worktreeSetup` **only on create**,
      sequential, stop-on-failure, with `TACHYON_WORKSPACE_ROOT`/`TACHYON_WORKTREE_ROOT`
      injected, timeout+cancel, awaited by the async spawn (NOT the UI thread),
      failure non-fatal; sub-agent (`parent`) → parent's cwd (ignore `worktree:true`
      + warn); non-usable-git (absent binary / not-repo / unborn / bare / add-fail)
      → workspace root + notice. Restart reuses (no re-setup). Unit-test resolution
      + inheritance + fallback (git mocked).
- [x] 5. **Kill/dismiss** flow: `canRemove` (block while descendants alive — offer
      "stop subtree first") → `status` → confirmation showing path + dirty +
      ahead/unpushed + ownership; accept → `remove` (worktree; `branch -D` only if
      Tachyon-created; human branch needs a 2nd explicit confirm); decline → keep
      agent + worktree + branch (+ a standalone "Remove worktree" action). nls (en+pt-br).
- [x] 6. **Studio** (`AgentForm`): `worktree` toggle + `branch` + `worktreeSetup`
      fields on the Agent and Terminal tabs; `studioSubmit` persists to yml.
- [x] 7. **Sidebar**: branch badge (`⎇ <branch>`) on worktree agents; tooltip notes
      the isolated branch.
- [x] 8. **MCP**: `spawn_agent` gains optional `worktree: boolean` (top-level only;
      ignored + warned on `parent` spawns). Update the tool description.
- [x] 9. **Docs**: README settings section (`settings.worktree`, per-agent
      `worktree`/`branch`/`worktreeSetup`) + Init scaffold commented hint.
- [x] 10. **Live smoke** (Extension Development Host, examples/orbit-api): spawn a
      `worktree:true` agent → confirm session cwd = `<base>/<wsHash>/<agent>` on its
      branch, edits isolated from main tree; spawn a sub-agent → shares the
      worktree; kill → uncommitted prompt → accept removes, decline keeps.

## Notes
- Pure-first (TDD) per spec 209's pattern: arg builders + resolvers unit-tested, git
  effects in one integration test, then a live smoke.
- C2 (diff-review) is a separate spec; this only exposes `worktreePathFor(agent)`.
