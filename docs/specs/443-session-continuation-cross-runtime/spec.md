# 443 — session-continuation-cross-runtime

_Created 2026-07-24._  
_Board: `t-7551f9` (feature) · sibling gate `t-6d09e6` (cmd change fail-closed)._  
_Inspiration: Orca “Continue in New Session” ([PR #9170](https://github.com/stablyai/orca/pull/9170)); not a pixel clone._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred. -->

## Intent

Humans hit usage limits or prefer another CLI family mid-task. Tachyon already has same-runtime resume/fork, multi-agent fleets, host handoff, and `probe_agent`. It lacked a **sequential handoff of an unfinished task onto a different declared agent** with a **new session** and **host-authored context**.

This spec defines **Continue task**: destination agent is spawned fresh with a focused handoff packet under `.tachyon/session-continuation/`. Native provider sessions are **not** migrated; tool state is **not** claimed portable; repository state is authoritative.

## Acceptance

- **Given** declared agents `from` and `to` with cmds (possibly different runtimes)
  - **When** `continue_task` / `agent.continue-task` runs with `to` stopped
  - **Then** a handoff file is written, `to` is spawned with that brief as `taskBrief`, source is left running/stopped as-is, and the API returns handoff id + path
- **Given** destination agent is running
  - **When** continue is requested
  - **Then** the call fails closed without spawning
- **Given** an agent’s cmd/runtime identity is edited while live (`t-6d09e6`)
  - **When** Studio save is attempted
  - **Then** save is refused; when stopped and identity changes, resume id is cleared

## Non-goals

- Native resume across providers
- Silent auto-switch on rate limit
- Hot-swap of account tokens
- Changing `cmd` as if it were session migration
- Full transcript injection as default (path optional later)

## Surface

| Surface | Role |
|---------|------|
| `src/sessionContinuation/*` | Packet + prepare |
| Bridge `continue_task` | Agent-callable |
| Extension `agent.continue-task` | Host/UI path |
| Agent Studio cmd edit | Fail-closed + clear resume (`t-6d09e6`) |
