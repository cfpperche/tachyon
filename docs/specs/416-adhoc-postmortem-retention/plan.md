# 416 — adhoc-postmortem-retention — plan

_Drafted from `spec.md` on 2026-07-19._

## Approach

Extend `SessionRecord` with a narrow optional lifecycle object whose v1 state is `clean-exited` plus an ISO timestamp. `dismissCleanExitPane` will capture output, kill the dead pane, persist that marker while preserving every other ledger field, then expose the existing in-memory `cleanExited` row. `rehydrateFromLedger` will rebuild both the ad-hoc definition and the clean-exit set. `planResume` will exclude terminal records, and successful spawn/restart persistence will omit or explicitly clear the old marker.

Remove the old render-time ledger deletion from `AgentManager.list()`: reads must not destroy the durable anchor. Explicit dismiss continues through `forgetAgent`, so existing transcript/activity/harness/session-owner cleanup remains canonical.

Preserve the authenticated coordinator on the managed agent-worktree row. Thread the already Bridge-resolved `delegator` through `SpawnCwdContext`, pass it to `syncAgentRecord`, and preserve it on later registry synchronization. The existing `canMutateManagedWorktree` creator rule then grants only the recorded coordinator; unrelated agents, dirty trees and occupied worktrees remain refused.

## Key decisions

- **Typed ledger lifecycle marker** — chosen because restart-safe state belongs beside the durable restart definition; rejected inference from transcript existence because transcripts can outlive deliberately dismissed rows.
- **Resume planner exclusion** — chosen because a terminal marker is stronger than resumability metadata; rejected deleting `resume` because explicit Restart may still need the full record and destructive field surgery would lose history.
- **Reuse existing creator authorization** — chosen because `createdBy` already has the required least-authority semantics; rejected broad parent/peer privilege checks at removal time because they would depend on mutable or missing live roster state.
- **No UI changes** — existing `cleanExited` projection and postmortem capability model already render the intended state once the row survives.

## Files touched

- `src/resume/SessionLedger.ts` — lifecycle type, defensive parser and record preservation.
- `src/resume/planResume.ts` — terminal records produce no activation action.
- `src/agents/AgentManager.ts` — persist/rehydrate/clear clean-exit state and thread coordinator identity.
- `src/workspace/Workspace.ts` — register delegated worktrees with their resolved coordinator.
- `src/worktree/ManagedWorktreeService.ts` — retain creator metadata across agent-record synchronization.
- Focused unit tests for ledger parsing, manager reconstruction, resume planning, Bridge postmortem behavior and worktree authorization.

## Risks & unknowns

- A stale marker must not leak into an explicitly restarted incarnation.
- Ledger mutation must preserve Delivery/worktree/evidence fields atomically.
- A malformed marker must fail open to legacy behavior, not fabricate terminal state.
- Creator preservation must not let a self-declared parent gain authority; only the Bridge-resolved delegator is threaded.

## Visual impact

No new visual design. The existing stopped/postmortem row persists across engine reconstruction instead of disappearing. Headless model and Bridge tests cover the projection.

## Sources consulted

- `src/agents/AgentManager.ts` (`list`, `dismissCleanExitPane`, `rehydrateFromLedger`, spawn/restart persistence).
- `src/resume/SessionLedger.ts` and `src/resume/planResume.ts`.
- `src/worktree/{managedWorktree,ManagedWorktreeService}.ts`.
- `src/bridge/tools.ts` authenticated `spawn_agent` parent resolution.
- `docs/specs/330-postmortem-agent-ux/`.
