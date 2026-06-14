# 214 — tachyon-verify-gate — tasks

**Verify:** `npm run typecheck && npm test`

## Implementation

- [x] 1. **Config + pure `src/worktree/verify.ts`**: parse agent `verify: <name>` +
      `settings.worktree.verify` (loadConfig + schema). `verify.ts`: `VerifyState`
      ({command, passed, atCommit, ranAt}); `effectiveVerify` (per-agent > global);
      `suggestVerify(stackLabel, pkgScripts)`; `verifyStale(state, headRef, dirty)`;
      `verifyBadge`; `verifySteps` (runbook name → steps, else single step). Unit-tested, no git.
- [x] 2. **Runner cwd override**: CommandRunner.run(name, cwd?) + RunbookRunner.run(rb, cwd?)
      and a new `runSteps(label, steps, cwd?)` (the verify executor). Unit-tested.
- [x] 3. **Workspace.runVerify(agent)**: resolve the agent's worktree + effective verify →
      run via RunbookRunner.runSteps in the worktree cwd (label `verify:<agent>`) → record
      `VerifyState` (atCommit snapshotted via WorktreeManager.headState). verifySteps unit-tested.
- [x] 3b. **Persist `VerifyState`** on the WorktreeRecord (SessionLedger.recordVerify + parse). Tested.
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
