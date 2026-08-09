# 333 — claude-graceful-stop-interrupt

_Created 2026-07-02._

**Status:** shipped

**Closure:** Implemented in AgentManager.ts (interruptCodexTurnIfActive -> interruptActiveTurn, called for both codex and claude; unconditional C-c composer clear before claude's C-d) + agentManager.test.ts new/updated coverage. npm test (2037 passed) and npm run typecheck both green. Dogfood opted out (no live TUI harness headlessly); human dogfood steps recorded in tasks.md.
**Verify:** `npm test -- --run test/unit/agentManager.test.ts`
**Verify:** `npm run typecheck`
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Graceful Stop on a `claude`-runtime agent that is mid-turn does not work. `stopGracefully` (`src/agents/AgentManager.ts:810`) only pre-interrupts an active turn for `codex` (`interruptCodexTurnIfActive`: active turn → `Escape` + 500ms wait → `C-d` lands on an idle composer and exits). For `claude` it sends `C-d` (+ a second `C-d` after 150ms) with no pre-interrupt at all. In the Claude Code TUI, Ctrl+D only exits at an **idle prompt with an empty composer** — mid-turn it's a no-op, and with draft text in the composer it's a delete-char keystroke. The result: the row sits in the "stopping…" badge state (`stoppingSince`) until `STOPPING_FALLBACK_MS` (15s) elapses and the UI reverts as if Stop was never requested — this is the maintainer's exact repro (Stop on a working `claude` agent). A second, narrower hole: even when `claude` is idle, a leftover composer draft (e.g. a queued `notify_agent` envelope) also defeats the plain `C-d`.

The existing turn-active detector, `isCodexTurnActive` (`AgentManager.ts:40`), already matches Claude Code's status line (`\besc to interrupt\b`) as well as codex's — it was never codex-specific, just never called for claude. Done means: `stopGracefully` pre-interrupts an active turn for *both* runtimes (send `Escape`, wait, confirm no longer mid-turn) and clears any composer draft for `claude` before the existing `C-d` dance, so Stop on a working `claude` agent exits within the normal graceful-stop path instead of falling back to the 15s badge revert.

## Acceptance criteria

- [x] **Scenario: Stop interrupts an actively-working claude agent**
  - **Given** a running `claude` agent whose pane shows an active-turn status line (matches the existing turn-active pattern, e.g. `"esc to interrupt"`)
  - **When** `stopGracefully` is called
  - **Then** it sends `Escape` (and waits) before proceeding to the `C-d` exit dance, the same as it already does for `codex`
- [x] **Scenario: Stop clears a leftover composer draft on an idle claude agent**
  - **Given** a running `claude` agent that is idle (no active-turn status line) but whose composer holds draft text
  - **When** `stopGracefully` is called
  - **Then** it clears the composer (sends `C-c`) before sending `C-d`, so the `C-d` is interpreted as exit rather than delete-char
- [x] **Scenario: Stop on an idle, empty-composer claude agent is unchanged**
  - **Given** a running `claude` agent that is idle with an empty composer (today's working case)
  - **When** `stopGracefully` is called
  - **Then** it still exits via the existing `C-d` / second-`C-d`-after-150ms dance, with no behavior regression
- [x] **Scenario: codex behavior is unchanged**
  - **Given** a running `codex` agent, active or idle
  - **When** `stopGracefully` is called
  - **Then** the pre-interrupt + `C-d` sequence is byte-for-byte what it was before this spec (existing codex tests keep passing unmodified)
- [x] The turn-active detector (`isCodexTurnActive` / its generalized successor) is invoked for both `claude` and `codex` runtimes from `stopGracefully`, not gated to `codex` only.
- [x] `npm test` and `npx tsc --noEmit` (both `tsconfig` targets used by this repo's typecheck script) are green after the change.

## Non-goals

- Not touching postmortem/dismiss logic (`dismissCleanExitPane`, `capturePostmortemOutput`, `postmortemTail`, etc. — spec 330 territory) or `src/bridge/tools.ts`.
- Not changing the 150ms second-`C-d` timing for claude's existing idle-exit path.
- Not building a live/real-tmux TUI harness for this fix — validation is via the existing fake-tmux unit-test style already used for the codex interrupt tests (`test/unit/agentManager.test.ts`).
- Not re-diagnosing the bug — the root cause is taken as given from pin `p-bfe6c0`; this spec is the fix + validation.

## Open questions

- Exact interrupt wait duration for claude's `Escape` (pin flagged "validar delay pro claude"): resolved pragmatically by reusing the existing 500ms constant already used for codex, since no headless harness in this environment can empirically time a live Claude Code TUI. Flagged in `plan.md` as a candidate for human dogfood / live tuning if the maintainer observes a race in practice.
