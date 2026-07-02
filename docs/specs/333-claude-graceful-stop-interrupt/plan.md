# 333 — claude-graceful-stop-interrupt — plan

_Drafted from `spec.md` on 2026-07-02. The approach, not the steps (those go in `tasks.md`)._

## Approach

Generalize the existing codex-only pre-interrupt in `stopGracefully` (`AgentManager.ts:810`) to both runtimes, and add a claude-only composer-clear step, without touching the postmortem/dismiss code that shares the file (spec 330 territory — off limits per pin).

1. Rename the private helper `interruptCodexTurnIfActive` → `interruptActiveTurn` (body unchanged: capture pane, `isCodexTurnActive(pane)` check, `Escape`, `sleep(500)`). The detector function itself (`isCodexTurnActive`, line 40) is left as-is — it already matches claude's `"esc to interrupt"` status line, so no change needed there beyond the call site.
2. In `stopGracefully`, call `interruptActiveTurn(session)` for both `binary === "codex"` and `binary === "claude"` (currently gated to `=== "codex"` only).
3. For `binary === "claude"`, send `C-c` (clear composer draft) immediately before the existing `C-d`. This runs whether or not a turn was active — it's the fix for the idle-with-draft hole (pin's "buraco 2"), and is a no-op on an already-empty composer per the pin's diagnosis.
4. Leave the existing 150ms-then-second-`C-d` claude dance untouched.
5. Add/update unit tests in `test/unit/agentManager.test.ts` using the same fake-tmux harness already used for the codex interrupt tests (lines ~148-176): a claude-active-turn case (expects `Escape`, `C-c`, `C-d`, and — since pane state doesn't flip in the fake — the second `C-d` after 150ms), a claude-idle-with-draft case, and confirm the existing codex tests and the existing "idle empty-composer claude" test still pass (updating their expected `sentKeys` arrays where the new unconditional `C-c` changes them).

## Key decisions

- **Send `C-c` unconditionally for claude before `C-d`, not conditionally on detected draft text** — chosen because there's no reliable pane-content signal for "composer has a draft" (unlike the turn-active status line, a draft is just arbitrary user text at the prompt); rejected trying to parse composer contents because it's fragile and the pin already established a plain `C-c` is a safe no-op on an empty composer.
- **Reuse the existing 500ms post-`Escape` wait for claude instead of a separate constant** — chosen because there's no headless way to empirically time a live Claude Code TUI in this environment, and inventing a second unverified constant would be worse than reusing the one already proven for codex; flagged as an open question for human/live tuning.
- **Rename `interruptCodexTurnIfActive` → `interruptActiveTurn` rather than leaving the codex-specific name** — chosen for readability now that it's called for two runtimes; rejected keeping the old name because a `codex`-named method invoked under `binary === "claude"` would mislead the next reader.
- **Leave `isCodexTurnActive` (the detector) unrenamed** — chosen to keep the diff minimal and scoped (pin explicitly names it as reusable as-is); a rename is cosmetic and not required for correctness, so deferred to avoid touching more surface than needed.

## Files touched

- `src/agents/AgentManager.ts` — generalize the pre-interrupt call in `stopGracefully`, rename/reuse the helper, add the claude composer-clear `C-c`.
- `test/unit/agentManager.test.ts` — new/updated cases for claude active-turn interrupt and idle-with-draft composer clear; adjust `sentKeys` expectations on the existing idle-claude test for the new unconditional `C-c`.

## Risks & unknowns

- **Unverified live timing**: the 500ms wait and the semantics of `C-c` on Claude Code's real TUI are taken from the pin's diagnosis, not re-verified against a live process in this headless environment. Documented as an open question in `spec.md`; human dogfood step recorded in `tasks.md` for the maintainer to confirm on a real pane.
- **Existing test breakage**: the current "stopGracefully sends Claude's second EOF when the pane stays alive" test asserts `sentKeys == [C-d, C-d]` with no `C-c` — this will need updating to include the new `C-c`, which is an intentional, spec-required behavior change, not a regression.
- **Shared-file risk**: `AgentManager.ts` was recently hot with spec 330 (postmortem/dismiss). Confirmed clean tree and spec 330 already committed (`eb31781`) before starting; touching only `stopGracefully`/`interruptActiveTurn` keeps this change disjoint from `dismissCleanExitPane`/`capturePostmortemOutput`/`postmortemTail`.

## Visual impact

None — this is a backend tmux-key-sequencing change inside `AgentManager`. No rendered UI surface changes (the sidebar's "stopping…" badge behavior is a consequence of timing, not a new visual element). No visual QA artifact planned; see Dogfood-Opt-Out in `tasks.md`.

## Sources consulted

- Pin `p-bfe6c0` (full diagnosis).
- `src/agents/AgentManager.ts:40` (`isCodexTurnActive`), `:266` (`STOPPING_FALLBACK_MS`), `:810-844` (`stopGracefully` + `interruptCodexTurnIfActive`).
- `test/unit/agentManager.test.ts:138-176` (existing stop/interrupt test cases — the pattern this spec's new tests follow).
- Project handoff: spec 330 (postmortem-agent-ux) committed `eb31781`; `git status` confirmed clean before starting.
