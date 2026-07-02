# 315 — persistence-stop-hook-dogfood — tasks

_Generated from `plan.md` on 2026-07-01. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Draft/update plan.md after owner ratifies this child spec as the next implementation target.
- [x] Record real maintainer Stop/Resume dogfood evidence before closing.
- [x] Decide the Codex TUI Stop loading path: emit separate documented `-c key=value` overrides instead of a multiline blob.
- [x] Generate implementation tasks if the decision requires code.
- [x] Implement separate Codex `SessionStart` and `Stop` CLI override injection.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Claude Stop hook row is still reproducible in `.tachyon/activity/persistence-stop.jsonl`.
- [x] Codex persisted TUI Stop hook either records a real row or is explicitly documented as blocked by Codex hook trust.
- [x] `/hooks` in a fresh persisted Codex TUI shows `Stop Installed 1` after the separate `-c` override fix.

**Verify:** `npm test -- test/unit/codexBridge.test.ts test/unit/sessionOwners.test.ts test/unit/harness.test.ts test/unit/agentManager.test.ts && npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `tail -n 30 .tachyon/activity/persistence-stop.jsonl && tail -n 30 .tachyon/activity/persistence-hooks-failures.jsonl 2>/dev/null || true`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Stop and resume a persisted Claude agent and a persisted Codex agent from the Tachyon sidebar, then inspect
`.tachyon/activity/persistence-stop.jsonl`, `.tachyon/activity/persistence-hooks-failures.jsonl`, and the visible pane for
unexpected typed Tachyon nudges.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->
