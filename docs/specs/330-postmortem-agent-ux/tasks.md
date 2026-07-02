# 330 — postmortem-agent-ux — tasks

_Generated from `plan.md` on 2026-07-02. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add a bounded session-local postmortem output buffer with line/byte caps and truncation metadata.
- [x] Capture the bounded tail before `dismissCleanExitPane` kills a clean-exit dead pane.
- [x] Make `dismiss_agent`/ad-hoc dismiss destroy retained postmortem output and document that destruction.
- [x] Add a pure managed-row capability helper or equivalent typed function for output/dismiss affordances.
- [x] Enrich `list_agents` rows with additive `capabilities` metadata.
- [x] Update `read_output` to distinguish live pane, stopped listed row with retained output, stopped-no-postmortem, and unknown row.
- [x] Add optional bounded `tailLines` to `wait_for_agent` and return `tail` or `tailUnavailableReason` only when requested.
- [x] Update Bridge tool descriptions for the postmortem contract.
- [x] Add/adjust Bridge tests for capability metadata, postmortem `read_output`, unknown `read_output`, final-tail wait, and capture-failure wait.
- [x] Add `dismiss` to the sidebar action vocabulary with a distinct label/icon and route it through the existing ad-hoc dismiss command path.
- [x] Update sidebar model/action tests for clean-exited ad-hoc, running ad-hoc, declared stopped, and terminal rows.
- [ ] Run visual inspection of a clean-exited ad-hoc row after packaging/install dogfood.

## Verification

- [x] `list_agents` exposes `capabilities.canDismiss` for stopped ad-hoc rows and false for running/declared rows.
- [x] `read_output` no longer returns generic "not running" for stopped listed rows.
- [x] `wait_for_agent(until=dead, tailLines=N)` returns a bounded `tail` when capture is available.
- [x] `wait_for_agent(until=dead, tailLines=N)` still succeeds with `tailUnavailableReason` when capture is unavailable.
- [x] Sidebar action matrix exposes Dismiss, not Kill/Stop/Open Terminal, for clean-exited ad-hoc rows.
- [x] Retained postmortem output is truncated by byte/line caps and removed after dismiss.

**Headless check:** `npm test -- --run test/unit/bridge.test.ts test/unit/agentManager.test.ts test/unit/sidebarActions.test.ts test/unit/agentModel.test.ts`
**Verify:** `npm test -- --run test/unit/bridge.test.ts test/unit/agentManager.test.ts test/unit/sidebarActions.test.ts test/unit/agentModel.test.ts`

## Dogfood

**Dogfood:** `npm test -- --run test/unit/bridge.test.ts -t "postmortem|final tail|dismiss_agent"`

**Human dogfood:** After installing the VSIX, spawn a short ad-hoc agent through the Bridge, wait for clean exit,
confirm `list_agents` capabilities, confirm `read_output` state-specific behavior, confirm
`wait_for_agent(..., tailLines)` on a second short agent captures or explains the tail, and inspect the sidebar
row actions before dismissing it.

## Visual QA

- [ ] Evidence: pending human/VS Code sidebar dogfood.
- [ ] Verdict: pending.
