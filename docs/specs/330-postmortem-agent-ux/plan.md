# 330 — postmortem-agent-ux — plan

_Drafted from `spec.md` on 2026-07-02. The approach, not the steps (those go in `tasks.md`)._

## Approach

Treat postmortem as a capability layer over the existing lifecycle model, not as a new lifecycle state. The raw
manager rows already distinguish running/dead/cleanExited/declared/adhoc; Bridge and sidebar should translate
that into explicit client affordances. Folded probe decision: all four improvements depend on one bounded
postmortem-output source, so build that first and layer the API/UI affordances on top.

1. Add a bounded, session-local postmortem output buffer in the manager/Bridge layer. It is not a durable archive.
   The source of truth should be:
   - Live/dead tmux pane when it still exists.
   - A bounded retained tail captured before Tachyon intentionally kills a clean-exit dead pane via
     `dismissCleanExitPane`.
   - No output after `dismiss_agent`, because dismiss is the explicit destructor for the ad-hoc row and its
     postmortem footprint.

   The buffer must be capped by both line count and byte count, and every returned postmortem payload must state
   whether it was truncated. Cap: 1000 lines and 64 KiB, with `wait_for_agent(tailLines)` clamped to 200 lines
   plus the same byte cap for tool-result ergonomics.

2. Add a small shared capability helper for managed rows. It should compute:
   - `canReadOutput`: true when `read_output` can return terminal output now.
   - `readOutputState`: `live` | `postmortem` | `unavailable`.
   - `readOutputReason`: optional human/agent-readable reason when unavailable.
   - `canDismiss`: true only for stopped non-declared rows.
   - `dismissReason`: optional reason when false.

3. Update `list_agents` to include a nested `capabilities` object rather than sprinkling new top-level booleans.
   This keeps backward compatibility and gives Bridge clients one obvious place to look. Existing top-level
   lifecycle fields remain unchanged. Capabilities are advisory hints computed at serialization time; each action
   endpoint remains authoritative and must re-check state because a row can change after `list_agents`.

4. Improve `read_output` semantics. It should:
   - Return the live pane when tmux still has the session.
   - Return the dead-pane/postmortem buffer when the row is stopped but output exists, including metadata such as
     `postmortem: true` and `truncated`.
   - If no tmux session exists, consult `manager.list()`/capabilities and the retained buffer.
   - For a stopped listed row without retained output, return a state-specific error such as
     `agent '<name>' is stopped and no postmortem output is available`.
   - For an unknown row, return `agent '<name>' not found`.

   Response shape should stay MCP-text compatible but become structured JSON when metadata is needed. Existing
   clients that only display text still see output text; clients that care can inspect status metadata. Unknown or
   dismissed agents keep using errors.

5. Add optional `tailLines` to `wait_for_agent`. On a met result for `dead`, read from the same finalized
   postmortem source as `read_output`, not a separate live capture path. Clamp server-side by both line and byte
   caps. If the wait times out while the agent is still running, do not return a tail; return the normal timeout
   result. If the agent is dead but tail capture/buffer retrieval fails, return the wait result plus a non-fatal
   `tailUnavailableReason` instead of failing the wait.

6. Update the sidebar view model/action matrix:
   - Add capability fields to `AgentVM` only where UI needs them (`canDismiss`, maybe `canReadOutput` if useful
     for terminal action gating).
   - Introduce a `dismiss` action id with label "Dismiss" and a distinct icon from declared `delete`, routed to
     the existing delete/dismiss command path for ad-hoc rows.
   - For clean-exited ad-hoc rows, do not surface Stop/Kill/Open Terminal. Surface Activity for AI rows,
     Resume when resumable, Restart, and Dismiss.
   - Keep declared stopped rows on Start/Edit/Delete semantics; declared delete remains config deletion, not
     postmortem dismiss.
   - Treat UI capabilities as hints only; command handlers and Bridge tools continue to enforce declared/running
     guards server-side.

7. Update tool descriptions and focused tests first; implementation should be driven by Bridge tests and pure
   sidebar action-matrix tests.

## Key decisions

- **One bounded postmortem buffer before API/UI changes** — folded from Claude/Fable. Without one source of truth,
  `read_output`, `wait_for_agent(tailLines)`, `list_agents` capabilities, and `dismiss_agent` destruction semantics
  can disagree.
- **Capability object over top-level booleans** — keeps the existing JSON stable while giving new clients a
  durable contract. Capabilities are advisory; tools still re-validate.
- **No durable output archive in v1** — the observed bug is UX/DX inconsistency, not a storage feature. A bounded
  session-local buffer covers short-lived smoke/delegation flows without designing transcript retention.
- **`wait_for_agent(tailLines)` reads finalized postmortem output without changing wait success** — waiting and
  reading are separate concerns; a failed capture should not turn a successful process exit into an error.
- **Sidebar gets explicit `dismiss` vocabulary** — reusing `delete` internally is fine, but the row action should
  say what the user is actually doing to an ad-hoc postmortem row.

## Files touched

- `src/bridge/tools.ts` — `list_agents` capabilities, `read_output` state-specific behavior, `wait_for_agent`
  `tailLines` input/result, tool descriptions.
- `src/bridge/Waiters.ts` if needed — only if final-tail capture belongs below `executeWait`; prefer keeping it
  in `tools.ts` unless the helper is shared.
- `src/agents/AgentManager.ts` / managed row types — bounded postmortem tail retention before
  `dismissCleanExitPane` kills a dead pane; formal capability helper if it belongs with manager state.
- `src/sidebar/types.ts` — optional UI-facing capability fields.
- `src/sidebar/agentModel.ts` — map raw row/capability data into `AgentVM`.
- `src/sidebar/actions.ts` — add `dismiss`, remove impossible postmortem actions.
- `src/webview/sidebar/App.tsx` — route/display the new action if the action id is not already generic.
- `src/webview/SidebarPrototype.ts` / `src/extension.ts` — provider and command routing for the new action id.
- `test/unit/bridge.test.ts` — Bridge contract tests for capabilities, `read_output`, and `wait_for_agent(tailLines)`.
- `test/unit/sidebarActions.test.ts` / `test/unit/agentModel.test.ts` — action matrix and VM mapping.
- `docs/specs/330-postmortem-agent-ux/*` — SDD artifacts.

## Risks & unknowns

- Tmux may not retain a captureable pane after `dismissCleanExitPane`. Capture the bounded tail before killing the
  dead pane, and test both retained-output and no-output paths.
- A `capabilities` object can drift if computed separately in Bridge and sidebar. Prefer a shared pure helper or
  keep exact duplicated rules small and unit-tested.
- Adding a `dismiss` action id must not break existing package command/context contributions. It can route to the
  existing `tachyon.deleteAgentItem` command for v1.
- Tool result shape changes need to be additive. `wait_for_agent` must still return `{met,state,exitCode?,waitedMs}`
  for existing clients, with `tail` only when requested/available.
- MCP payload size must be capped by bytes, not only line count. A single long line can otherwise blow up context.

## Visual impact

Sidebar row actions change for stopped ad-hoc rows. Visual QA should inspect a clean-exited ad-hoc row after
dogfood: no Stop/Kill/Open Terminal quick action, Dismiss appears as cleanup, and text/actions do not overflow.

## Sources consulted

- Installed 0.54.43 dogfood: `agy-dismiss-smoke` clean-exited, stayed listed, `read_output` returned
  "agent is not running", `kill_agent` pointed to `dismiss_agent`, and `dismiss_agent` removed the row.
- `src/bridge/tools.ts` current `list_agents`, `read_output`, `wait_for_agent`, and `dismiss_agent`.
- `src/sidebar/actions.ts` current `hasPane`, clean-exit, primary/overflow action rules.
- `src/sidebar/agentModel.ts` current `cleanExited -> exited + pane:false` mapping.
- `src/webview/SidebarPrototype.ts` live sidebar provider mapping from `manager.list()` to `AgentVM`.
- `src/extension.ts` existing `deleteAgentItem` handler, which already uses "Dismiss" for ad-hoc rows.
- Claude/Fable probe `probe-5159b1ec-f676-4343-abfd-4c10254f5f15`, which required a bounded postmortem buffer,
  advisory nested capabilities, authoritative server-side guards, tail clamps, and ordered implementation slices.
