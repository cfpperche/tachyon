# 329 — bridge-dismiss-agent — tasks

_Generated from `plan.md` on 2026-07-02. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add `dismiss_agent` registration in `src/bridge/tools.ts` with a stopped-ad-hoc-only description.
- [x] Implement state guards using `manager.list()` before dismiss: unknown, declared, running, stopped ad-hoc.
- [x] Improve `kill_agent` error text for stopped ad-hoc rows to suggest `dismiss_agent`.
- [x] Make `AgentManager.dismissAdhoc` trigger the existing lifecycle/view refresh callback.
- [x] Add focused MCP tests for successful dismiss, declared rejection, running rejection, unknown rejection, and kill guidance.
- [x] Update Bridge tool-list expectations and any affected counts/comments.

## Verification

- [x] `dismiss_agent` appears in `listTools`.
- [x] Bridge dismiss removes stopped ad-hoc rows from `list_agents`.
- [x] Bridge dismiss rejects running ad-hoc rows without removing them.
- [x] Bridge dismiss rejects declared rows.
- [x] `kill_agent` on a stopped ad-hoc row suggests `dismiss_agent`.

**Headless check:** `npm test -- --run test/unit/bridge.test.ts test/unit/agentManager.test.ts`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Verify:** `npm test -- --run test/unit/bridge.test.ts test/unit/agentManager.test.ts`

**Dogfood:** `npm test -- --run test/unit/bridge.test.ts -t dismiss_agent`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Spawn an ad-hoc Bridge smoke agent that exits cleanly, call `dismiss_agent`, and confirm
the row disappears from `list_agents` / sidebar without respawn+kill.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** Bridge/API lifecycle fix; listing behavior is covered by MCP tests.
