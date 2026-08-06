# Tasks 241 — per-agent continuity

## Read-path amendment

- [x] Add failing tests for derived work, stale verdicts, and drop warnings.
- [x] Add pure continuity response helpers.
- [x] Wire tasks and pins into `get_continuity`.
- [x] Add advisory reference-drop detection to `set_continuity`.
- [x] Update the tool description.
- [x] Run focused tests.
- [x] Run `npm run typecheck`.
- [x] Run `npm run verify:full:quiet` on the final tree.

**Verify:** `npm run typecheck`

**Dogfood-Opt-Out:** Bridge integration tests exercise the complete MCP tool door.

**Visual QA Opt-Out:** This amendment changes text tool responses only.

**Verify:** `cd /home/goat/tachyon && env -u TMUX npx vitest run`
**UI impact:** ui (sidebar badge + manual action; no project UI test runner — dogfood in EDH)

## Increment A — store + write contract + Bridge tools ✅
- [x] `ContinuityStore` (`.tachyon/continuity/<agent>.md`): atomic write, frontmatter, soft cap (D7), malformed rejection, unknown-field preservation.
- [x] Bridge tools `get_continuity` / `set_continuity` / `continuity_status` (D2 — `append` cut); wired into Workspace + BridgeDeps.
- [x] Tests: `test/unit/continuity.test.ts` (9).

## Increment B — discontinuity state (D9) + classifier (D3) ✅
- [x] `ContinuityState` sidecar (separate from sessionId).
- [x] PURE `classifyInjection` — clean-resume = no inject; post-compaction-resume / restart / new-session / compaction-idle / manual = inject; done never as active.
- [x] Idle-hook wiring: compaction (`onCompaction`) + session-change (`transitions` counter) detection; serial `recoverOnIdle`.
- [x] Tests: `test/unit/continuityClassifier.test.ts` (12).

## Increment C — freshness (D4) + nudges (D5/OQ1) + cold start (OQ3) ✅
- [x] Exact lag (durable-log line count) + stale wording past `staleLag`; done/paused not active.
- [x] Restore not cooldown-gated (flag-clear dedupes); proactive idle checkpoint reminder cooldown-gated (`reminderText`).
- [x] Cold start → "no brief" nudge + missing badge.

## Increment D — badge (OQ4) + manual command + gitignore (D10) ✅
- [x] `AgentVM.continuity: fresh|stale|missing` + sidebar badge (stale/missing) + `continuityBadge`.
- [x] `Tachyon: Re-inject Continuity` command/action (manual path) + i18n (en + pt-BR).
- [x] `.tachyon/continuity/` gitignored.

## Increment E — fork snapshot (D8) + pre-teardown (OQ6) + delete cleanup ✅
- [x] Fork → paused snapshot of parent brief + `forked_from_*` + re-scope note.
- [x] Bounded (≤8s hard cap, idle+active+stale only) pre-teardown checkpoint; never blocks restart.
- [x] Delete reaps brief + state.

## Closure
**Closure:** Increments A–E shipped. Codex: debate SPEC-READY-WITH-CHANGES (D3 fix + D7–D10) → impl SHIP-WITH-CHANGES (6 defects: baseline race, shared-cooldown restore suppression, malformed-as-cold-start, reanchor/continuity pane race, unbounded pre-teardown, tmp collision — all folded) → re-confirm 6 FIXED + 2 residuals (malformed warning spam, no in-flight guard — both folded). 868 unit tests green (continuity ×9, classifier/state ×12); tsc + engine-boundary + build clean. **EDH validation pending** (the user's gate — sidebar badge + the in-pane injection are UI; ships unpublished). Known v1 scope (Non-goals): no LLM auto-summary, no token-pressure trigger, per-agent only; the Workspace injection-wiring is vscode-adjacent (CI covers the pure classifier/state/store, not the live idle-hook side effects).
