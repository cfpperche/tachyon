# 384 — agent-live-branch-badge — tasks

**Verify:** `npx vitest run test/unit/agentModel.test.ts test/unit/sidebarPrototype.test.ts`
**Verify:** `npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`
**Dogfood:** `npx vitest run test/unit/agentLiveBranch.dogfood.test.ts`
**Dogfood:** `npm run build && npm run dogfood:dev-host -- headless`
**Human dogfood:** with ≥1 worktree agent and ≥1 shared agent, confirm first badge is live branch; checkout in worktree and confirm badge/drift after refresh.

## Tasks

- [x] T1 — Add `currentBranch(cwd)` (best-effort) on `WorktreeManager`
- [x] T2 — Extend `AgentVM` / `AgentExtras` with `liveBranch?`, `branchDrift?`, `worktreePath?`; map in `toAgentVM`
- [x] T3 — In `SidebarPrototype` fleet gather: resolve cwd per agent, read live branch, set drift vs ledger worktree branch
- [x] T4 — `AgentBadges`: render branch badge **first**; drop mid-list config-only `⎇ worktree` display (keep `worktree` for actions)
- [x] T5 — `hasMeta` includes `liveBranch`; SAMPLE / fixtures if needed
- [x] T6 — Unit tests: mapping + badge order / drift flags
- [x] T7 — Run declared Verify commands; log in notes
