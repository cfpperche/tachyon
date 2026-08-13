# 503 — notify-agent-stranded-composer

_Created 2026-08-13._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

`notify_agent` queues while a recipient is working. On the one working-to-idle drain, the runtime can be in its terminal handback transition: Tachyon types the queued notice and presses Enter, but the runtime does not accept the submit. The submission is correctly reported unconfirmed and the queue retains its item. The same line is now staged in the composer, however, so every later delivery path classifies Tachyon's own text as a human draft and refuses to retry. With no second idle edge, the live agent becomes unreachable.

## Acceptance criteria

- [ ] **Scenario: recover Tachyon's own stranded queued notice**
  - **Given** a notice queued while an agent was working and staged-but-unsubmitted during its working-to-idle drain
  - **When** recovery runs again or another notice arrives
  - **Then** Tachyon recognizes the exact queued notice in the composer and retries its submit without typing the line twice
- [ ] **Scenario: preserve a real human draft**
  - **Given** a non-empty composer whose text is not the exact queued Tachyon notice
  - **When** notify, write-input, retask, or the queued drain reaches the pane
  - **Then** the human draft is not overwritten or submitted
- [ ] A fail-before test reproduces the retained queue, staged tool text, single exhausted idle edge, and closed delivery doors.
- [ ] The root cause and measured live timing are recorded.

## Non-goals

- Eliminating the accepted tmux read/write race where a human keystroke lands between observation and write.
- Weakening generic composer-occupancy protection.
- Changing Design Mode or `src/webview/ide-browser-bridge/`.

## Open questions

None. The retained queue item is the out-of-band ownership mark. Prefix/suffix alone are insufficient authority because a human can paste arbitrary text; recovery requires exact equality with the retained queue head.

## Measurement

The incident doorbell was accepted at 2026-08-13T15:48:00.715Z. The recipient completed at 15:53:56Z and the staged notice was still present at 16:06:51Z: at least 12m55s after completion and 18m50s after enqueue. The ledger records one causative `claude -> pagebundle` notice; later retries were consequences held behind the same composer.
