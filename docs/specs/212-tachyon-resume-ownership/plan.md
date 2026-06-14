# 212 — tachyon-resume-ownership — plan

## Architecture

Extends the spec-209 resume layer; no new module. The work is one new pure resolver,
one dispatch fn, and one stop/kill hook that writes back to the ledger.

```
src/resume/resolvers.ts
  ├─ resolveClaudeId(cwd, env)            # NEW — newest *.jsonl by mtime in
  │                                        #   ~/.claude/projects/<encodeClaudeCwd(cwd)>/
  └─ resolveCurrentSession(runtime, cwd)  # NEW dispatch: claude→resolveClaudeId,
                                          #   codex→resolveCodexId, opencode→resolveOpencodeId,
                                          #   qwen/gemini/continue→null (no derivable map)

src/agents/AgentManager.ts
  └─ kill() / restart() — before tearing the session down, if the agent has a resume
     block AND its cwd is unambiguous, refresh resume.sessionId via a new injected
     opts.resolveCurrentSession; transcript-existence gated; never nulls a good id.

src/workspace/Workspace.ts
  └─ wire opts.resolveCurrentSession = resolveCurrentSession (real disk), like resolveCaptureId.
```

`encodeClaudeCwd` and `transcriptPath` already live in adapters.ts (reuse for the
existence check). `findFiles` (newest-first) already exists in resolvers.ts — reuse it
for the claude resolver.

## cwd-ambiguity gate

Before refreshing, AgentManager checks the ledger: the agent's cwd is "unambiguous" iff
no OTHER ledger row shares the same `cwd`. A worktree agent's cwd is inherently unique
(`<base>/<wsHash>/<agent>`), so it always passes; agents on the shared workspace root only
pass when they're the lone one there. Pure check over `ledger.all()`.

## Sequencing

1. `resolveClaudeId` + `resolveCurrentSession` dispatch + fixture tests (no real disk).
2. AgentManager refresh hook at kill/restart (cwd-ambiguity gate + transcript check),
   injected `resolveCurrentSession` seam; unit-test the refresh/skip matrix (mocked).
3. Workspace wiring (real disk resolver).
4. Live smoke: claude agent, /resume inside, stop, ↻ → lands on the switched session.
5. Docs: a line in the resume section (README) on ownership-follows-/resume + the gemini gap.

## Risks / edges

- **Shared cwd** — gated out (skip refresh); documented. Worktrees make it clean.
- **gemini/continue** — null resolver → no refresh, stays pinned; documented gap, no crash.
- **transcript vanished between resolve and resume** — resume() already re-checks and falls
  back to a fresh spawn; the refresh additionally gates on existence at write time.
- **Self-managed cmds** (`claude --resume X`) — have no resume block (spec 211 fix), so the
  refresh never touches them; their continuity is the user's `--resume` arg, unchanged.
