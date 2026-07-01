# 305 — codex-activity-runtime

_Created 2026-06-30._

**Status:** shipped
**Closure:** Shipped 2026-06-30: Codex Activity now resolves rollout paths safely (`resolveCodexSession` + ownership/shared-cwd policy), writes structured durable `runtime:"codex"` events through a Codex normalizer, preserves Claude Activity behavior through a runtime normalizer factory, and includes focused tests plus headless dogfood against a real local Codex rollout schema proof. Validation: focused verify, `npm run typecheck`, `npm test`, and `node scripts/dogfood-codex-activity.mjs` passed.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

The Activity log shipped first for Claude. Codex agents are now resumable and Tachyon can own their session
home, but Activity still has two Claude-only assumptions: `AgentManager.transcriptPathOf()` only works when a
runtime adapter can derive a transcript path from an id, and `ActivityLogWriter` always feeds lines through
`createClaudeNormalizer()`. For Codex this means the Activity view has no structured feed even though Codex
persists JSONL transcripts under `CODEX_HOME` / `~/.codex/sessions`.

This spec makes Codex the second structured Activity runtime. A Codex agent should resolve its current rollout
file without unsafe shared-cwd guessing, tail that file through a Codex normalizer, and render user/assistant/tool
activity from the durable Tachyon log while preserving Claude behavior.

## Acceptance criteria

- [x] **Scenario: Codex transcript path is resolved**
  - **Given** a Codex agent with a resumable ledger row and a matching rollout under an isolated `CODEX_HOME`
  - **When** Tachyon asks `transcriptPathOf("codex", { live: true })`
  - **Then** it returns the rollout path and `runtime: "codex"`
- [x] **Scenario: shared cwd does not misattribute Codex**
  - **Given** two resumable agents sharing the same cwd and config home
  - **When** the target Codex agent has no authoritative ownership row and no stored session path
  - **Then** Tachyon returns no transcript path instead of tailing a sibling's newest rollout
- [x] **Scenario: Codex Activity renders structured events**
  - **Given** a Codex rollout containing `response_item` user/assistant/tool records
  - **When** `ActivityLogWriter` polls that rollout
  - **Then** `.tachyon/activity/<agent>.jsonl` contains renderable `runtime:"codex"` events and the Activity view shows messages/tools, not raw-only fallback
- [x] **Scenario: Claude Activity is unchanged**
  - **Given** existing Claude Activity fixtures and tests
  - **When** the new runtime registry is used
  - **Then** Claude events still normalize and render with the existing behavior
- [x] Unknown Codex JSONL records do not throw and do not bloat the durable log with raw-only noise.

## Non-goals

- It does not implement every historical or future Codex transcript shape. v1 supports the record types observed
  in current local rollout files and degrades safely for unknown records.
- It does not change the Activity UI layout beyond showing Codex as a structured runtime.
- It does not add support for other capture runtimes such as OpenCode, Qwen, Gemini, or Continue.
- It does not clone raw Codex transcripts into `.tachyon/activity`; the durable log remains normalized events plus
  source pointers.

## Open questions

- Answered: the ad-hoc Claude design review was folded into the implementation and notes.
