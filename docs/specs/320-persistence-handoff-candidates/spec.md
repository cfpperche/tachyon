# 320 — persistence-handoff-candidates

_Created 2026-07-01._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Spec 312 deliberately avoids fabricating semantic project handoff notes from runtime hooks. That is the right v1 boundary,
but there may be value in using end-of-turn evidence to draft candidate handoff notes for human/agent review. This must
be designed carefully: an automatic candidate system that creates noise or false project state would recreate the same
human irritation that silent hooks were meant to remove.

Done means Tachyon has a review-gated candidate lane, separate from official project handoff notes, with clear evidence
and discard/accept behavior. This is intentionally later than the reliability specs and may become a separate epic if it
needs data or runtime behavior outside the persistence-hook reliability boundary.

## Acceptance criteria

- [ ] **Scenario: candidate is separate from official handoff**
  - **Given** a runtime turn produces evidence that may matter to project state
  - **When** Tachyon drafts a handoff candidate
  - **Then** the canonical handoff and pending handoff notes are unchanged until a human or explicit agent action accepts it
- [ ] **Scenario: candidate has evidence**
  - **Given** a candidate is displayed
  - **When** the user reviews it
  - **Then** it includes source agent, timestamp, and evidence pointers sufficient to decide whether to accept or discard
- [ ] **Scenario: low-noise candidate policy**
  - **Given** an agent turn has no clear project-level state change
  - **When** the candidate system evaluates it
  - **Then** Tachyon does not create a candidate just because a Stop hook fired
- [ ] **Scenario: accept candidate**
  - **Given** a candidate is accepted
  - **When** Tachyon records it
  - **Then** it becomes a normal pending handoff note with explicit attribution
- [ ] Candidate generation is opt-in or conservative by default.
- [ ] The design includes a discard path and retention policy for stale candidates.
- [ ] Minimum historical data needs are defined before spec 319 finalizes pruning windows.

## Non-goals

- Replace `append_project_handoff_note` for agents that already know what changed.
- Auto-distill the shared handoff.
- Type handoff reminders into panes.
- Start before specs 315-319 give deterministic proof, health, logging, and retention foundations.

## Open questions

- **OQ1 — Generation source.** Decide later whether candidates come from deterministic event heuristics, explicit
  summarize commands, or a bounded probe; do not assume LLM generation in the umbrella.
- **OQ2 — Epic boundary.** If candidates require LLM summarization or broader activity retention, split this out of
  persistence-hooks v2 reliability work instead of blocking 315-319.
