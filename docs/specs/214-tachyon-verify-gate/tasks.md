# 214 — tachyon-verify-gate — tasks

**Verify:** `npm run typecheck && npm test`

## Implementation

- [ ] 1. **Config + pure `src/worktree/verify.ts`**: parse agent `verify: <name>` +
      `settings.worktree.verify` (loadConfig + schema). `verify.ts`: `VerifyState`
      ({passed, atCommit, ranAt}); `suggestVerify(stack, pkgScripts)` (Node → package.json
      test/lint/build scripts; cargo/go/pytest/etc.); `verifyStale(state, headRef, dirty)`.
      Unit-tested, no git.
- [ ] 2. **Runner cwd override**: CommandRunner + RunbookRunner take an optional `cwd`
      (default workspaceRoot). Unit-test that the worktree cwd flows into newSession.
- [ ] 3. **Workspace.runVerify(agent)**: resolve the agent's worktree (record) + its declared
      verify name → run that command/runbook in the worktree cwd → record `VerifyState`
      (atCommit = worktree HEAD via WorktreeManager) on the persisted record. Unit-test the
      resolution + record (git/runner mocked).
- [ ] 3b. **Persist `VerifyState`** alongside the WorktreeRecord (SessionLedger).
- [ ] 4. **Sidebar badge**: `✓ verified` / `✗ failing` / `⊘ not verified` (stale) on worktree
      agents (reuse WorktreeManager.status for the dirty/HEAD staleness); tooltip with ranAt.
- [ ] 5. **Studio `verify` field** (AgentForm worktree section): stack-suggested chips (reuse
      Init/cliDetect stack detection + package.json scripts) the human picks/overrides;
      `studioSubmit` persists to yml. nls (en+pt-br).
- [ ] 6. **MCP**: `list_agents` exposes VerifyState; `verify_agent` tool runs the declared gate
      in the worktree + returns {passed, atCommit}. Update tool count/tests.
- [ ] 7. **Extension action** `tachyon.verifyAgentItem` (inline ✓-run on worktree agents) +
      palette-hidden; package.json + nls.
- [ ] 8. **Docs**: README worktree section — the verify-gate + validated-handoff line.
- [ ] 9. **Live smoke** (EDH): a worktree agent with `verify: test` → Verify → ✓; break a test
      → ✗; commit more → ⊘ stale; a parent reads the green via list_agents/verify_agent.

## Notes
- Reuses commands/runbooks (no new executor). Studio stack-suggestion mirrors Init. Human has
  the final word on the verify command. Advisory only — never blocks merge (human-at-gate).
- TDD + codex dueto, like 210/212/213.
