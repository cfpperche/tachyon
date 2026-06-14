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
- [x] 4. **Sidebar badge**: `✓/✗/⊘` on worktree agents via Workspace.verifyInfo (HEAD/dirty
      staleness from WorktreeManager.headState); tooltip with ranAt + state.
- [x] 5. **Studio `verify` field** (AgentForm worktree section): stack-suggested chips
      (Workspace.verifyCandidates = detectStack + package.json scripts + declared command/runbook
      names) the human picks/overrides; persists to yml via toEntry/fromDef. nls (en+pt-br).
- [x] 6. **MCP**: `list_agents` exposes the verify handoff; `verify_agent` tool runs the gate +
      returns {command, passed, atCommit, ranAt, stale}. Tool count 19 → 20; tests updated.
- [x] 7. **Extension action** `tachyon.verifyAgentItem` (inline ✓ on `-verifiable` worktree
      agents) + palette-hidden; package.json + nls (en+pt-br).
- [ ] 8. **Docs**: README worktree section — the verify-gate + validated-handoff line.
- [ ] 9. **Live smoke** (EDH): a worktree agent with `verify: test` → Verify → ✓; break a test
      → ✗; commit more → ⊘ stale; a parent reads the green via list_agents/verify_agent.

## Notes
- Reuses commands/runbooks (no new executor). Studio stack-suggestion mirrors Init. Human has
  the final word on the verify command. Advisory only — never blocks merge (human-at-gate).
- TDD + codex dueto, like 210/212/213.
