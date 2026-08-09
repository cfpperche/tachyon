# 341 — notify-agent-idle-delivery

_Created 2026-07-03._

**Status:** shipped
**Closure:** Implemented 2026-07-03 — `notify_agent` now routes through semantic notice delivery, busy recipients queue until idle, Workspace flushes one notice through the recovery mutex, child death-pokes use the same path, and `TmuxService.sendSubmittedLine` performs delayed submit with capture-based retry. Verified with the spec headless check and `npm run typecheck`.
**Verify:** `npm test -- test/unit/notifyAgent.test.ts test/unit/noticeQueue.test.ts test/unit/tmux.test.ts test/unit/bridge.test.ts test/unit/workspaceHeadless.test.ts`
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

`notify_agent` currently types a one-line `[tachyon]` envelope into the recipient's tmux pane and immediately sends one Enter. Pin `p-c77b48` showed that when the recipient TUI is mid-turn, the paste can stick while Enter is swallowed, leaving the envelope stranded in the composer until a human presses Enter or deletes it.

Done means `notify_agent` remains a wake-up path, but it no longer blindly submits into a busy recipient. Tachyon queues notices for a recipient that is working/throttled, flushes them only when the recipient is idle, and uses a hardened submit helper that verifies whether the pasted line is still visible before retrying Enter. The tool result must tell the sender whether the notice was delivered immediately or queued.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: idle recipient**
  - **Given** a running agent target whose attention state is idle
  - **When** another agent calls `notify_agent`
  - **Then** Tachyon submits one sanitized `[tachyon]` envelope immediately and reports `notified`
- [x] **Scenario: busy recipient**
  - **Given** a running agent target whose attention state is working or throttled
  - **When** another agent calls `notify_agent`
  - **Then** Tachyon stores the envelope in a bounded per-target queue without typing into the pane and reports `queued`
- [x] **Scenario: idle flush**
  - **Given** a queued notice for a running agent target
  - **When** the target transitions to idle
  - **Then** Tachyon submits the next queued notice serially through the hardened submit helper
- [x] **Scenario: needs-input is not safe**
  - **Given** a queued notice for a target that transitions to needs-input
  - **When** Tachyon observes that state
  - **Then** Tachyon does not type or submit the notice
- [x] **Scenario: stranded queue cleanup**
  - **Given** queued notices for a target that dies, restarts, or remains undeliverable past the notice TTL
  - **When** Tachyon handles the lifecycle event or the next queue operation runs cleanup
  - **Then** stale notices are discarded rather than being delivered into a later unrelated session
- [x] Existing validation remains fail-closed: self-notify, non-agent targets, missing sessions, and empty sanitized summaries still fail.
- [x] `write_input` keeps its current raw pane-input semantics; this spec only changes semantic notices such as `notify_agent` and child death-pokes.

## Non-goals

- This is not a durable message bus. Queued notices are best-effort runtime state, not persisted project history.
  **Reversed in part, 2026-08-06 — see `## Amendments` below.** The bullet above is left exactly as
  written: it was the right call with what was known in July, and this is the record of that.
- This does not make notices safe while a human is actively typing in the recipient pane; stale attention state can still race with human input.
- This does not redesign agent-to-agent coordination around a file inbox or runtime hooks.
- This does not change generic `write_input` behavior.

## Open questions

- Answered during implementation: queue defaults are 20 notices per target, drop-oldest on overflow, and a 10 minute TTL for stale notices.

## Amendments

- **2026-08-06 — first non-goal ("not a durable message bus / not persisted project history")
  partially reversed by `docs/specs/493-doorbell-read-inbox/spec.md`.** That spec adds `summary`/
  `pointer` fields to the witness record `.tachyon/doorbells.jsonl` already kept for every `notify_agent`
  call, and a `read_notices` tool to read it back. The other three non-goals on this page — human-typing
  safety, no file-inbox redesign, `write_input` unchanged — were NOT reopened and still hold. The TTL
  and the single `working→idle` drain window (this page's own delivery mechanism) are also unchanged;
  493 only makes the RECORD of a doorbell durable and readable, not the delivery itself. See 493's
  "Supersedes" section for why the July reasoning stopped fitting a coordinator that runs continuously
  and rarely goes idle.
