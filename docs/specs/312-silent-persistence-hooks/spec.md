# 312 — silent-persistence-hooks

_Created 2026-07-01._

**Status:** shipped
**Closure:** Shipped silent persistence hooks for declared Claude/Codex agents: SessionStart now carries a continuity pointer silently, Stop records deterministic persistence lifecycle evidence, automatic continuity/handoff pane nudges are suppressed only when the current spawn actually received the silent hook bundle, and `settings.persistence.silentHooks: false` restores the legacy visible path.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

> **t-7bcba6 (2026-07-12):** The `settings.persistence.silentHooks` kill switch and the `tachyon.persistenceSettings` / “Visible legacy reminders” UI were **removed**. Silent hooks remain the only supported path for eligible declared Claude/Codex agents. This shipped history is not rewritten; the kill switch is obsolete product surface, not current behavior.


## Intent

Continuity and handoff reminders currently reach agents by typing visible "nudges" into their terminal panes. That keeps
agents from losing context, but it is noisy for the human: leaving a workspace open can fill panes with Tachyon messages
and interrupt the natural terminal experience.

Done means persistence maintenance moves to runtime-native hooks for **persisted/declarative agents**. Tachyon should
silently inject per-agent hooks during spawn/restart/resume, using Claude/Codex supported hook events, so continuity and
handoff bookkeeping happens without `tmux send-keys` messages to the pane. Ad-hoc agents remain persistence-off by
default unless a later explicit opt-in is designed.

## Acceptance criteria

- [x] **Scenario: no visible automatic persistence nudges**
  - **Given** a persisted Claude or Codex agent is running
  - **When** Tachyon detects continuity/handoff maintenance opportunities
  - **Then** Tachyon does not type reminder text into the user's terminal pane
- [x] **Scenario: continuity rehydration via hook context**
  - **Given** a persisted agent has an active continuity brief
  - **When** the runtime starts, resumes, clears, or compacts
  - **Then** Tachyon's injected `SessionStart` hook supplies the brief pointer/context through runtime-native hook output
- [x] **Scenario: handoff maintenance via stop hook**
  - **Given** a persisted agent finishes a turn after project-level work
  - **When** the runtime fires `Stop`
  - **Then** Tachyon's injected hook performs deterministic bookkeeping silently and never types the append-note reminder into the pane
- [x] **Scenario: explicit handoff authoring remains agent/human-owned**
  - **Given** a runtime fires `Stop`
  - **When** the agent did not explicitly call `append_project_handoff_note`
  - **Then** Tachyon does not fabricate a semantic project handoff note from the hook alone
- [x] **Scenario: ad-hoc agents stay quiet**
  - **Given** an ad-hoc/fork/probe agent is spawned
  - **When** it runs, resumes, or stops
  - **Then** Tachyon does not inject persistence hooks unless a future explicit opt-in exists
- [x] Hook injection remains additive and does not remove user/project hooks.
- [x] Existing activity session-ownership hooks continue to work for Claude and Codex.

## Non-goals

- Implementing persistence hooks for ad-hoc agents.
- Sending visible terminal reminders as the default path.
- Replacing user-authored Claude/Codex hooks.
- Building LLM summarization inside hook scripts in this pass; hooks should do deterministic bookkeeping first.
- Changing MCP/skills/harness behavior beyond the hook injection needed for persistence.

## Open questions

- **OQ1 — Stop hook output semantics.** RESOLVED: `Stop` must never force a continuation or fabricate semantic handoff
  content. V1 may update deterministic cursors/health only; project handoff content remains explicit through
  `append_project_handoff_note` or the human handoff UI.
- **OQ2 — Continuity write authority.** Should hooks create/update `continuity.md` automatically, or only rehydrate from an
  agent-authored brief? Recommendation: rehydrate only in v1; automatic authoring needs a separate contract.
- **OQ3 — Config surface.** RESOLVED: default on for persisted agents, with a workspace kill switch in `tachyon.yml`.
