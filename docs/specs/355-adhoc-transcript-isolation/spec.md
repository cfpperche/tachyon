# 355 — adhoc-transcript-isolation

_Created 2026-07-04._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Ad-hoc AI agents now receive ownership-only SessionStart hooks so Activity can attribute their transcripts without enabling persistence features such as continuity/handoff. The dogfood for 0.55.20 proved that both Claude and Codex ad-hoc agents write Activity, but Codex can still show the stale `history unavailable — agent shares this folder with no distinct session` banner when it starts in the same workspace folder as its parent.

Done means ad-hoc Claude and Codex agents get their own transcript namespace by default, using the existing lightweight transcript-isolation mechanism, while keeping persistence disabled. The Activity view should not show the shared-folder history warning when ownership or config-home isolation makes the transcript attributable.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: Codex ad-hoc starts in an isolated transcript namespace**
  - **Given** a Bridge-spawned ad-hoc Codex agent in the same cwd as its parent
  - **When** Tachyon builds and records the spawn
  - **Then** the agent runs with `CODEX_HOME` under `.tachyon/harness/<agent>`
  - **Then** its ledger `resume.configHome` points at that same private home
  - **Then** the ad-hoc still receives only the ownership SessionStart hook, not continuity/handoff/stop persistence hooks
- [x] **Scenario: Claude ad-hoc starts in an isolated transcript namespace**
  - **Given** a Bridge-spawned ad-hoc Claude agent in the same cwd as its parent
  - **When** Tachyon builds and records the spawn
  - **Then** the agent runs with `CLAUDE_CONFIG_DIR` under `.tachyon/harness/<agent>`
  - **Then** its ledger `resume.configHome` points at that same private home
  - **Then** the ad-hoc still receives only the ownership SessionStart hook, not continuity/handoff/stop persistence hooks
- [x] **Scenario: Activity warning is not shown for attributable ad-hoc Activity**
  - **Given** an ad-hoc agent shares cwd with another agent
  - **When** the Activity panel can attribute the current transcript via a private config home or a valid ownership row
  - **Then** the `history unavailable` banner is not rendered
- [x] **Scenario: Activity warning remains for truly ambiguous shared-cwd sessions**
  - **Given** two resumable agents share both cwd and config home and the selected agent has no captured session id or ownership row
  - **When** the Activity panel opens
  - **Then** the `history unavailable` banner is still rendered

## Non-goals

- Does not enable continuity, handoff, or Stop persistence hooks for ad-hoc agents.
- Does not isolate pure terminals or unknown runtimes.
- Does not change git worktree isolation behavior.
- Does not alter declared-agent `isolate: transcript` semantics.

## Open questions

- None.
