# 329 — bridge-dismiss-agent — plan

_Drafted from `spec.md` on 2026-07-02. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add a new MCP Bridge tool `dismiss_agent` beside `kill_agent`. The tool first inspects `manager.list()`
so it can distinguish unknown, declared, running ad-hoc, and stopped ad-hoc entries. It only calls
`manager.dismissAdhoc(name)` for a non-declared entry with no live session. Error messages are explicit:
running ad-hoc users are told to call `kill_agent` first; declared agents are told they cannot be dismissed
through the Bridge; unknown names return "agent not found".

Keep `kill_agent` as the live-session primitive. Improve its error path by consulting `manager.list()` when
`manager.kill()` fails: if the target is a stopped ad-hoc entry, return a clear error that says to call
`dismiss_agent`; otherwise preserve the existing failure shape.

Make `AgentManager.dismissAdhoc` notify the lifecycle callback after it removes the ad-hoc row. The existing
UI command currently calls `refreshAll()` after dismiss, but Bridge calls do not; moving the view-change
signal into the manager path keeps both doors consistent.

## Key decisions

- **Explicit `dismiss_agent` instead of overloading `kill_agent`** — chosen because "kill" is a process
  operation and "dismiss" is a stopped-row lifecycle operation. Overloading would hide destructive cleanup
  behind a command whose name implies a live session.
- **Reject running ad-hoc dismiss** — folded from Claude/Fable probe. Calling `dismissAdhoc` while a tmux
  session is alive can orphan the process from manager state.
- **Reject declared agents** — Bridge dismiss is for ephemeral/ad-hoc rows. Declared deletion needs YAML
  mutation and human confirmation, which is out of scope.
- **Manager emits refresh on dismiss** — Bridge lacks extension-level `refreshAll()`, so the shared manager
  path must trigger the same refresh callback used by spawn/kill.

## Files touched

- `src/bridge/tools.ts` — register `dismiss_agent`, add guarded lifecycle checks, improve stopped-ad-hoc
  `kill_agent` guidance.
- `src/agents/AgentManager.ts` — make `dismissAdhoc` fire the existing lifecycle callback after cleanup.
- `test/unit/bridge.test.ts` — MCP end-to-end coverage for the new tool and kill guidance.
- `test/unit/agentManager.test.ts` — focused lifecycle callback coverage for `dismissAdhoc` if needed.
- `docs/specs/329-bridge-dismiss-agent/*` — SDD artifacts and verification log.

## Risks & unknowns

- `manager.list()` has side effects for clean-exit dead panes: it may reap ledger rows. The Bridge already uses
  it for `list_agents`, so this is acceptable but tests should assert the visible state, not internal maps.
- Adding `onKilled` to `dismissAdhoc` may double-refresh the existing UI delete path. That is acceptable; it
  should not double-delete because cleanup is idempotent.
- The Bridge tool list count/snapshot must be updated or CI will fail.
- `dismiss_agent` is destructive for an ephemeral row's activity log; tool description must make that clear.

## Visual impact

No new UI. Sidebar behavior changes only through existing refresh: a dismissed ad-hoc row disappears.
**Visual QA Opt-Out:** Bridge/API lifecycle fix; behavior is covered by MCP/listing tests.

## Sources consulted

- Incident dogfood: Bridge-spawned `agy-smoke` and `agy-smoke-2` remained in `list_agents` after clean exit;
  `kill_agent` returned "not running"; workaround was respawn+kill.
- `src/bridge/tools.ts` current `spawn_agent`, `kill_agent`, and `list_agents` tools.
- `src/agents/AgentManager.ts` `dismissAdhoc`, `removeEphemeralFootprint`, `kill`, and `list`.
- `src/extension.ts` UI delete/dismiss flow for ad-hoc rows.
- Claude/Fable probe `probe-779d7a4e-aa61-4596-8fc0-4d9b308b1ae6`, which flagged running-ad-hoc orphan risk,
  sidebar refresh risk, and kill-message state distinctions.
