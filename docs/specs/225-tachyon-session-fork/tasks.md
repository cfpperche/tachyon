# 225 — tachyon-session-fork — tasks

**Verify:** `npm run typecheck && npx vitest run` (safe with `$TMUX` set — spec 218 guard)

## Design — DONE
- [x] Decisions locked (context-up-to-fork; sibling; native-fork-only, seed DEFERRED + documented;
      new worktree off committed HEAD + dirty warning; manual trigger).
- [x] Step 1 — `claude --fork-session` verified (carries context, new session, original intact).
- [x] Step 1b — `claude -n <fork> --resume <uuid> --fork-session` verified (named fork, customTitle=fork).
- [x] codex design debate → BUILD-MVP claude-native manual fork.

## Step 2 — cwd-scope verification (live, 2026-06-16) — DONE, CHANGES task 3
**`claude --resume <uuid>` resolves the session ONLY within the current cwd's encoded project dir**
(`~/.claude/projects/<encodeClaudeCwd(cwd)>/`). Verified live (3 isolated /tmp cwds, claude 2.1.178):
fork from a DIFFERENT cwd → `No conversation found with session ID` (exit 2); fork from the SAME cwd →
context carried + new transcript. **Implication:** a worktree fork (new cwd) loses context UNLESS the
source transcript is seeded into the fork cwd's project dir first. **Also verified:** copying
`<uuid>.jsonl` into the fork cwd's project dir → `--resume <uuid> --fork-session` from there carries
context AND writes the fork's new session there. So the worktree fork = create worktree → **seed the
transcript** → spawn. (Non-worktree fork shares the source cwd → no copy needed.)

## Implementation (claude-native MVP)
- [x] 1. **adapters.ts** — `forkCommand?(cmd, sourceId): string` capability + `forkable()`. claude →
      append `--resume <sourceId> --fork-session`; all others omit it. (commit a24c7bd.)
- [x] 2. **AgentManager.planFork/commitFork(name)** — split: `planFork` fail-closes (resolve the live
      uuid via spec-220 customTitle capture; unresolved → `ForkUnavailableError "not forkable yet"`) and
      returns a side-effect-free plan (forkName `<orig>-fork-N` unique across config/ledger/tmux,
      base cmd, dirty); `commitFork` spawns `claude -n <fork-name> --resume <uuid> --fork-session`.
      PERSISTENT sibling ledger row: `def.cmd`=BASE cmd, `def.fork:true` (survives Stop until Dismiss —
      kill() guards on it), resume keyed to `<fork-name>`, NO parent lineage.
- [x] 3. **Worktree fork** — `WorktreeManager.createFork(forkAgent, forkBranch, baseBranch)` →
      `git worktree add -b <fork-branch> <path> <orig-branch>` (off committed HEAD), `dirty` warning.
      **+ transcript seed** (`seedTranscript` dep, default fs copy) into the fork cwd's project dir
      (step-2 finding). Fail-closed: a worktree source whose worktree can't be created throws (never
      forks into the wrong cwd). No worktree → fork shares the source cwd.
- [x] 4. **UI** — `tachyon.forkAgentItem` + inline action gated on a `-forkable` contextValue (running
      agent on a fork-capable, non-self-managed runtime); confirm shows fork name + base + dirty warning.
- [x] 5. **Docs** — README "Session fork" section with the per-runtime support note (claude-only today).
- [x] 6. **Tests** — adapter forkCommand (resume.test); planFork fail-closed + name uniqueness;
      commitFork cmd shape + persistent sibling row + survives-Stop/Dismiss + worktree seed + fail-closed;
      WorktreeManager.createFork (off committed HEAD, dup refuse). 505 unit + typecheck green.
- [x] 7. **codex dueto** (gpt-5.5 high, 3 rounds) → SHIP. R1: 4 MAJOR (seed not fail-closed → silent
      context loss; orphan worktree/session on post-create failure; stale/concurrent forkName;
      fork-a-non-running source) + 1 MINOR (managesOwnSession) — all fixed. R2: 2 (commitFork used a
      stale plan.sourceId after the modal aged; fork lost source env on restart/resume) — fixed via
      `resolveForkSource` re-resolve at commit + `SessionDef.env`. R3: SHIP, no findings. → ship 0.21.0.

## Notes
- The fork command is SPAWN-TIME only; the ledger stores the base cmd + the fork-name so a later
  stop→resume of the fork resumes the FORK's own session (never re-forks the original).
- Fail-closed: never guess a running agent's session id; if unresolved, the action says so.
- **Persistence mechanism:** `SessionDef.fork:true` (durable in the ledger); `kill()` keeps the row +
  in-memory adhoc def for a fork (so it stays listed + resumable), dropping them only on `dismissAdhoc`.
- **cwd-scope (step 2):** the seed-copy leaves a foreign-titled transcript (the original's) in the fork
  worktree's project dir — harmless (the worktree is ephemeral; capture resolves the fork by its OWN
  customTitle). Accepted for MVP.
