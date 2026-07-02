# 333 — claude-graceful-stop-interrupt — tasks

_Generated from `plan.md` on 2026-07-02. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Confirm clean tree and `git status` before editing `AgentManager.ts` (spec 330 shares the file; stop if uncommitted changes from another agent are present).
- [x] Rename `interruptCodexTurnIfActive` → `interruptActiveTurn` in `src/agents/AgentManager.ts` (no body change).
- [x] In `stopGracefully`, call `interruptActiveTurn(session)` for `binary === "codex"` OR `binary === "claude"` (was `codex`-only).
- [x] In `stopGracefully`, for `binary === "claude"`, send `C-c` immediately before the existing `C-d` (unconditional composer clear).
- [x] Update the existing "stopGracefully sends Claude's second EOF when the pane stays alive" test's expected `sentKeys` to include the new `C-c`.
- [x] Add a test: claude with an active-turn pane (`"esc to interrupt"` match) → expects `Escape` before the `C-d` dance.
- [x] Add a test: claude idle with a composer draft (non-empty pane, no active-turn match) → expects `C-c` then `C-d` (no `Escape`).
- [x] Re-confirm the two existing codex tests (`interrupts an active Codex turn`, `does not interrupt an idle Codex pane`) pass unmodified.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Scenario: Stop interrupts an actively-working claude agent — covered by new `agentManager.test.ts` case.
- [x] Scenario: Stop clears a leftover composer draft on an idle claude agent — covered by new `agentManager.test.ts` case.
- [x] Scenario: Stop on an idle, empty-composer claude agent is unchanged — covered by updated existing test (still ends in `C-d`, `C-d`; only the leading `C-c` is new since composer is empty either way, per plan's "unconditional, no-op when empty" decision — re-verify this test's intent still matches the scenario name after the `C-c` is added).
- [x] Scenario: codex behavior is unchanged — existing codex tests pass unmodified.
- [x] `npm test` and `npm run typecheck` green.

**Headless check:** `npm test -- --run test/unit/agentManager.test.ts && npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

**Verify:** `npm test -- --run test/unit/agentManager.test.ts`
**Verify:** `npm run typecheck`

## Dogfood

**Dogfood-Opt-Out:** No live TUI/tmux harness exists in this headless environment to exercise a real Claude Code pane's key-sequence semantics end-to-end (same posture as spec 330's backend-only opt-out). The fix is exhaustively covered by fake-tmux unit tests exercising the exact pane-content-driven state machine `stopGracefully` runs on; see Human dogfood below for the live-timing check this environment cannot perform.

**Human dogfood:** Spawn a `claude` agent, give it a long-running task so its pane shows the active-turn status line, click Stop in the sidebar, and confirm it exits within a couple seconds (not the 15s `stoppingSince` fallback revert). Separately, type a few characters into an idle claude agent's composer without submitting, click Stop, and confirm it still exits cleanly.

## Visual QA

**Visual QA Opt-Out:** Backend tmux-key-sequencing change with no new rendered surface — the sidebar's existing "stopping…" badge is unchanged code, only its timing outcome changes.
