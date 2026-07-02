# 320 — persistence-handoff-candidates

_Created 2026-07-01._

**Status:** superseded
**Closure:** Superseded 2026-07-02 by the existing Project Handoff pending-notes lane. The owner identified that a
separate candidate queue would duplicate `append_project_handoff_note` pending notes, which already keep proposed
project-state updates separate from the canonical handoff until distillation. No implementation shipped.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Spec 312 deliberately avoids fabricating semantic project handoff notes from runtime hooks. That is the right v1 boundary,
but there may be value in using end-of-turn evidence to draft candidate handoff notes for human/agent review. This must
be designed carefully: an automatic candidate system that creates noise or false project state would recreate the same
human irritation that silent hooks were meant to remove.

Canceled decision: do not build a second candidate lane. The existing Project Handoff pending-notes lane already gives
Tachyon a review-gated buffer separate from the canonical handoff, with explicit agent attribution and evidence.
Adding `candidate -> pending note -> canonical handoff` would create another queue to review without a clear product gain.

## Acceptance criteria

- [x] **Scenario: candidate is separate from official handoff**
  - **Given** a runtime turn produces evidence that may matter to project state
  - **When** Tachyon drafts a handoff candidate
  - **Then** the canonical handoff and pending handoff notes are unchanged until a human or explicit agent action accepts it
  - **Decision:** already satisfied by pending notes staying outside the canonical handoff until distillation.
- [x] **Scenario: candidate has evidence**
  - **Given** a candidate is displayed
  - **When** the user reviews it
  - **Then** it includes source agent, timestamp, and evidence pointers sufficient to decide whether to accept or discard
  - **Decision:** pending notes already display author/time/summary and can include evidence pointers.
- [x] **Scenario: low-noise candidate policy**
  - **Given** an agent turn has no clear project-level state change
  - **When** the candidate system evaluates it
  - **Then** Tachyon does not create a candidate just because a Stop hook fired
  - **Decision:** no automatic candidate generation will be implemented.
- [x] **Scenario: accept candidate**
  - **Given** a candidate is accepted
  - **When** Tachyon records it
  - **Then** it becomes a normal pending handoff note with explicit attribution
  - **Decision:** explicit agent action should call `append_project_handoff_note` directly; there is no intermediate accept path.
- [x] Candidate generation is opt-in or conservative by default.
- [x] The design includes a discard path and retention policy for stale candidates.
- [x] Minimum historical data needs are defined before spec 319 finalizes pruning windows.

## Non-goals

- Replace `append_project_handoff_note` for agents that already know what changed.
- Auto-distill the shared handoff.
- Type handoff reminders into panes.
- Start before specs 315-319 give deterministic proof, health, logging, and retention foundations.

## Open questions

- **OQ1 — Generation source.** Resolved: none. Do not generate candidates from hooks, heuristics, probes, or LLMs in this
  umbrella.
- **OQ2 — Epic boundary.** Resolved: no follow-up epic unless a new product need appears. Improvements should target the
  existing pending-notes/distillation UX instead.
