# 212 — tachyon-resume-ownership — tasks

**Verify:** `npm run typecheck && npm test`

## Implementation

- [x] 1. **`resolveClaudeId(cwd, env)`** (`src/resume/resolvers.ts`): newest `*.jsonl`
      by mtime under `~/.claude/projects/<encodeClaudeCwd(cwd)>/` → basename uuid, or
      null. Reuse `findFiles`. Fixture-tested (tmp `.claude/projects` tree, mtimes).
- [x] 2. **`resolveCurrentSession(runtime, cwd, env)`** dispatch: claude→resolveClaudeId,
      codex→resolveCodexId, opencode→resolveOpencodeId, qwen/gemini/continue→null. Unit-test
      each branch (incl. the null gaps).
- [x] 3. **Refresh hook** in `AgentManager` (`kill` + `restart` pre-teardown): if the agent
      has a ledger `resume` block AND its cwd is unambiguous (no other ledger row shares the
      cwd), call injected `opts.resolveCurrentSession(runtime, cwd)`; if it returns a non-empty
      id whose transcript exists (adapter.transcriptPath + fileExists, when derivable), write
      it to `resume.sessionId`. Never null a good id; never refresh on a shared cwd. Add the
      `resolveCurrentSession` + reuse `fileExists`/`homeDir` opts seams. Unit-test the
      refresh/skip matrix (mint refreshes / shared-cwd skips / null keeps / gemini skips),
      git+disk mocked.
- [x] 4. **Wire** `Workspace`: `opts.resolveCurrentSession = (rt, cwd) => resolveCurrentSession(rt, cwd)`.
- [x] 5. **Docs**: README resume section — "ownership follows an in-TUI /resume (mint runtimes,
      unambiguous cwd); gemini/continue stay pinned (documented gap)".
- [x] 6. **Live smoke** (EDH): a `claude` agent (Tachyon-minted), run `/resume` to another
      session inside it, stop it, ↻ Resume → lands on the switched-to session; a second agent
      sharing the root is never cross-contaminated.

## Notes
- Pure-first per spec 209/210: resolvers fixture-tested, the refresh matrix unit-tested with
  mocks, then a live smoke (the on-disk claude layout + the TUI /resume can't be exercised headlessly).
- Self-managed `--resume` agents have no resume block → untouched (spec 211).
- C2 (diff-review) / C3 (verify-gate) remain separate; unrelated to this.
