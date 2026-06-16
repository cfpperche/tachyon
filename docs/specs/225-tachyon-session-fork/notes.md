# 225 — tachyon-session-fork — notes

## Status: SHIPPED v0.21.0 (2026-06-16, Opus 4.8)

Manual "Fork session" action that forks a RUNNING claude agent's session into a NEW sibling
(`<orig>-fork-N`) carrying context up to the fork instant (`claude -n <fork> --resume <uuid>
--fork-session`), original untouched. claude-only (native `--fork-session`); other runtimes don't
offer it (no lossy seed in v1).

## Critical live finding (2026-06-16) — claude `--resume` is cwd/project-dir-scoped
Verified in 3 isolated `/tmp` cwds (claude 2.1.178): `claude --resume <uuid>` resolves the session
ONLY within the current cwd's encoded project dir (`~/.claude/projects/<encodeClaudeCwd(cwd)>/`).
Forking from a DIFFERENT cwd → `No conversation found with session ID` (exit 2). Forking from the
SAME cwd → context carried + new transcript. **Also verified:** copying `<uuid>.jsonl` into the fork
cwd's project dir first → `--resume <uuid> --fork-session` from there carries context AND writes the
fork's own new session there. **Consequence:** a worktree fork (new cwd) must SEED the transcript into
the new cwd's project dir before spawning, or it loses the very context that is the point of forking.
The seed is FAIL-CLOSED (verify the dest landed, else abort + roll back the worktree).

## Mechanism
- **adapters.ts** — `forkCommand(cmd, sourceId)` (claude → `--resume <id> --fork-session`) + `forkable()`.
- **AgentManager** — `resolveForkSource(name)` (fail-closed: tracked session, native/forkable, base cmd,
  not self-managed, RUNNING, resolve the LIVE uuid via spec-220 customTitle capture, transcript on disk).
  `planFork` = resolve + unique `<orig>-fork-N` + dirty (for the confirm). `commitFork` RE-resolves at
  spawn (so a stale modal can't fork an old session): worktree source → `createFork` off committed HEAD
  + seed transcript (fail-closed); non-worktree → share the source cwd. Persistent SIBLING ledger row
  (base cmd + `def.fork:true` + source env, resume keyed to the fork's own name, NO parent lineage).
  Rollback (kill session + remove worktree) on any post-create failure.
- **Persistence** — `SessionDef.fork:true` (durable): `kill()` and the `list()` F6 clean-exit cleanup
  both keep a fork's row + adhoc def (resumable until explicit Dismiss). `SessionDef.env` persists the
  source's env so a model-swap (`ANTHROPIC_BASE_URL`) survives the fork's restart/resume + reload.
- **UI** — `tachyon.forkAgentItem` + inline action gated on `-forkable` (running, fork-capable, not
  self-managed); confirm modal shows fork name + base branch + dirty warning.

## codex dueto (gpt-5.5 high) — 3 rounds → SHIP
- **R1 CHANGES** — 4 MAJOR (seed not fail-closed; orphan worktree/session on post-create failure;
  stale/concurrent forkName; forked a non-running source) + 1 MINOR (managesOwnSession). All fixed.
- **R2 CHANGES** — commitFork trusted a stale `plan.sourceId` after the modal aged (forked an old
  transcript); the fork lost the source env on restart/resume. Fixed: `resolveForkSource` re-resolve at
  commit + `SessionDef.env` persisted/rehydrated.
- **R3 SHIP** — no findings; both R2 fixes confirmed, no regression.

## Verification
509 unit tests + typecheck + esbuild build green (`npm run typecheck && npx vitest run`, safe with `$TMUX`).
Adapter (resume.test), planFork fail-closed paths + name uniqueness, commitFork cmd shape + persistent
sibling + survives-Stop/Dismiss + env inherit + worktree seed + fail-closed seed/rollback + worktree
create-fail, `WorktreeManager.createFork` (off committed HEAD, dup refuse).

## Deferred (not v1)
Seed-summary fallback for non-native runtimes (lossy); auto "off-task" trigger; dirty-snapshot carry.
