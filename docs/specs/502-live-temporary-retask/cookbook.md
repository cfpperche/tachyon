# Cookbook — live-temporary-retask

_Operator/agent how-to for this shipped surface. Not the contract (`spec.md`) and not build memory (`notes.md`).
Write at ship time when the change introduces a usable API, Bridge tool, CLI, or lifecycle that a sibling agent
or human would otherwise reverse-engineer from code._

## When to use

- A live Temporary agent has finished or released its prior board task and should take a new triaged task without losing its conversation or checkout.

## When not to use

- Do not use it to restart a broken runtime, to reopen closed work, or while the agent still owns different active work.

## Happy path

1. Finish, close, or release the agent's prior active board assignment.
2. Triage the target task if it is still in inbox.
3. Call `retask_agent` with the live Temporary name and task id; the task is claimed and the fresh WORK ON RECORD is queued into the existing conversation.

## Tools / commands

| Action | Tool or command | Notes |
|--------|-----------------|-------|
| Retask live Temporary | `retask_agent` | `{ "name": "worker", "task_id": "t-abc123" }` |
| Prepare inbox work | `update_task` | Move to `triaged` first and journal the decision. |

## Fail-closed / safety

- Saved agents, terminals, stopped agents, inbox/closed tasks, tasks owned elsewhere, and agents with competing active work are refused before the claim.
- A synchronous projection/delivery failure restores a newly claimed task to its prior board state.
- The operation never calls restart, kill, dismiss, or a worktree resolver.

## Cleanup

1. No lifecycle cleanup is created. Complete or release the task through the ordinary board workflow.

## See also

- Contract: [`spec.md`](./spec.md)
- WORK ON RECORD renderer: `src/agents/sessionWorkRecord.ts`
