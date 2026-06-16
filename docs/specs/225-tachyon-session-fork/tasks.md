# 225 — tachyon-session-fork — tasks

**Verify:** `npm run typecheck && npx vitest run` (safe with `$TMUX` set — spec 218 guard)

## Design — DONE
- [x] Decisions locked (context-up-to-fork; sibling; native-fork-only, seed DEFERRED + documented;
      new worktree off committed HEAD + dirty warning; manual trigger).
- [x] Step 1 — `claude --fork-session` verified (carries context, new session, original intact).
- [x] Step 1b — `claude -n <fork> --resume <uuid> --fork-session` verified (named fork, customTitle=fork).
- [x] codex design debate → BUILD-MVP claude-native manual fork.

## Implementation (claude-native MVP)
- [ ] 1. **adapters.ts** — `forkCommand?(cmd, sourceId): string` capability. claude → append
      `--resume <sourceId> --fork-session`; all other adapters omit it (= not forkable). Add `forkable`
      = `!!adapter.forkCommand`.
- [ ] 2. **AgentManager.fork(name)** — fail-closed resolve the target's CURRENT uuid (spec-220
      customTitle capture; unresolved → throw "not forkable yet"). Compute a unique sibling name
      `<orig>-fork-N` (across config/ledger/tmux/worktree). Spawn `claude -n <fork-name>` + forkCommand
      (`--resume <uuid> --fork-session`). Record a PERSISTENT sibling ledger row: `def.cmd` = the BASE
      cmd (so future resume uses the normal named path, never re-forks), resume block keyed to
      `<fork-name>`, NO parent lineage. Survives ad-hoc kill until explicit dismiss.
- [ ] 3. **Worktree fork** — if the target has a worktree, create a new worktree branched off its
      COMMITTED HEAD (`git worktree add -b <fork-branch> <path> <orig-branch>`); warn that uncommitted
      changes aren't carried. No worktree → fork shares the workspace root.
- [ ] 4. **UI** — `tachyon.forkAgentItem` command + inline action gated on a `-forkable` contextValue
      (set when `adapter.forkCommand` exists); the fork appears as a sibling; a confirm shows the
      fork name + base + (if dirty) the uncommitted-changes warning.
- [ ] 5. **Docs** — README + a per-runtime fork-support note (claude-only today; extensible). Rig/site
      n/a.
- [ ] 6. **Tests** — adapter forkCommand (claude yes / others none); AgentManager.fork (name
      uniqueness, fail-closed on unresolved uuid, sibling row persists, base-cmd recorded); worktree
      branch. 
- [ ] 7. **codex dueto** → SHIP; ship 0.21.0.

## Notes
- The fork command is SPAWN-TIME only; the ledger stores the base cmd + the fork-name so a later
  stop→resume of the fork resumes the FORK's own session (never re-forks the original).
- Fail-closed: never guess a running agent's session id; if unresolved, the action says so.
