# Cookbook — Agent Evolution

_Operator/agent how-to. The product contract remains in [`spec.md`](./spec.md)._

## When to use

- Enable this for a declared Tachyon agent when useful lessons or repeatable procedures should survive
  completed Tasks and runtime changes.
- Use a learning proposal for a short reusable fact or correction. Use a skill proposal for a reusable
  procedure that benefits from a standard `SKILL.md`, scripts, references or assets.

## When not to use

- Do not use Evolution to change Soul, Role, Persistent Instructions, Project Guidance or the current Task.
- Do not enable it when the agent has no durable learning to retain. The feature is opt-in, and an empty
  task-end review is a valid result.

## Happy path

1. In Agent Studio, create or edit a declared agent and enable **Agent Evolution**. The equivalent YAML is:

   ```yaml
   agents:
     reviewer:
       cmd: codex
       selfEvolution:
         enabled: true
   ```

2. Assign a managed Task to that agent and move the Task through its normal completion flow to `done`.
   Tachyon sends one review notice for that completion.
3. The agent calls `submit_evolution_review` with the notice's `review_id`. Submit `proposals: []` when
   nothing should be retained, or propose independent learning/skill changes.
4. Open the saved agent in Agent Studio. Inspect each proposal's source Task, reason and exact content or
   file diff, then approve or reject it individually.
5. Start a fresh session to use approved learning and skills. The session that produced the proposal keeps
   its original snapshot.

Example skill proposal:

```json
{
  "review_id": "review-...",
  "proposals": [
    {
      "kind": "skill",
      "operation": "create",
      "name": "repo-check",
      "reason": "Reuse the repository check",
      "files": [
        {
          "path": "SKILL.md",
          "content": "---\nname: repo-check\ndescription: Run the repository check consistently.\n---\n\nRun the helper.\n"
        },
        {
          "path": "scripts/check.sh",
          "content": "#!/bin/sh\nnpm test\n",
          "executable": true
        }
      ]
    }
  ]
}
```

## Tools / commands

| Action | Tool or command | Notes |
|--------|-----------------|-------|
| Submit the task-end result | `submit_evolution_review` | Agent-authenticated Bridge tool; accepts up to eight independent proposals. |
| Inspect and decide | Agent Studio → Agent Evolution | Load proposal detail, then Approve or Reject. |
| Inspect active learning | `.tachyon/agents/<agent>/evolution/LEARNINGS.md` | Contains approved learning only. |
| Inspect active skills | `.tachyon/agents/<agent>/evolution/skills/` | Standard Agent Skills bundles, including optional helper files. |
| Run deterministic dogfood | `npm exec -- vite-node scripts/dogfood-agent-evolution.mts` | Uses and removes a temporary workspace. |

## Conflicts and unchanged state

- A review id belongs to its agent and completion. Replays with different proposals are rejected.
- Approval is refused if the active profile version or target changed after the proposal was loaded; reload
  the detail in Agent Studio before deciding again.
- An evolved skill cannot replace a same-named human-declared harness skill.
- Rejecting a proposal changes no active files. Approving changes the next profile version only.

## Cleanup

1. Turn off **Agent Evolution** (or remove `selfEvolution`) to stop reviews and startup delivery while
   retaining the profile for later use.
2. Renaming the agent moves its Evolution Profile with it.
3. Explicitly deleting/forgetting the declared agent removes its local Evolution Profile with the rest of
   that agent's Tachyon footprint.

## See also

- Contract: [`spec.md`](./spec.md)
- Delivery plan and ownership boundaries: [`plan.md`](./plan.md)
