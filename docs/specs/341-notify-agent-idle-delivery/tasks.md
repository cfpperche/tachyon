# 341 — notify-agent-idle-delivery — tasks

_Generated from `plan.md` on 2026-07-03. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add a pure bounded `NoticeQueue` with per-target FIFO, TTL cleanup, drop-oldest overflow, clear target, and one-at-a-time dequeue.
- [x] Add a semantic submitted-line helper to `TmuxService` that delays before Enter and only retries Enter when capture shows the line is still visible.
- [x] Extend `BridgeDeps` with `deliverNotice` and route `notify_agent` through it while preserving validation failures.
- [x] Add `Workspace` notice delivery ownership: enqueue based on attention, immediate fallback for missing monitor state, idle flush serialized with recovery, and queue cleanup on death/restart/kill.
- [x] Route child death-pokes through the same semantic notice delivery path.
- [x] Update tool descriptions and spec 332 notes where needed to reflect queued best-effort semantics.

## Verification

- [x] Unit tests cover immediate notify vs queued notify and truthful return text.
- [x] Unit tests cover no flush on `needs-input`, one flush on idle, serialized order, TTL cleanup, drop-oldest overflow, and clear-on-death/restart.
- [x] Unit tests cover the hardened tmux helper, including conditional retry.
- [x] Existing notify validation tests still pass.

**Headless check:** `npm test -- test/unit/notifyAgent.test.ts test/unit/noticeQueue.test.ts test/unit/tmux.test.ts test/unit/bridge.test.ts test/unit/workspaceHeadless.test.ts`
**Verify:** `npm test -- test/unit/notifyAgent.test.ts test/unit/noticeQueue.test.ts test/unit/tmux.test.ts test/unit/bridge.test.ts test/unit/workspaceHeadless.test.ts`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** Live Claude/Codex TUI timing is the meaningful dogfood for this flake; this spec records the manual route below because a deterministic headless command cannot prove terminal-runtime submit behavior.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Notify a busy Claude or Codex target and confirm the envelope is not typed while it is mid-turn; when it returns idle, confirm the notice submits. Also notify a target at a permission prompt and confirm Tachyon does not auto-accept the prompt.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** No rendered UI changes; affected surface is terminal input timing and tool result text.
