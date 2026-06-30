# 299 — managed-entry-taxonomy

_Created 2026-06-30._

**Status:** shipped
**Closure:** Implemented first-slice managed-entry terminology cleanup on 2026-06-30: neutral canonical aliases, compatibility MCP descriptions, docs/comment cleanup, Claude ad-hoc review folded in, and targeted tests + typecheck passed.
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes / placeholders). -->

## Intent

Tachyon already distinguishes AI CLIs from plain shells/dev servers with `kind: agent | terminal` and with separate human-facing `agents:` / `terminals:` config blocks. The remaining naming debt is below that surface: core types, manager APIs, MCP tools, commands, and docs still use `agent` as the umbrella term for every long-lived tmux-backed process. That makes terminals look like agents in public and internal contracts, and forces docs to explain that "agent" sometimes means "managed entry".

This spec realigns the domain language without a breaking rename. `agent` remains the name for LLM-backed entries. `terminal` remains the name for non-AI entries. The umbrella concept becomes a neutral managed entry/process concept in code and documentation, while `tmux session` and runtime conversation/resume session stay distinct. Compatibility aliases stay in place for `tachyon.yml`, MCP tools, commands, and existing tests until a later deprecation window.

## Acceptance criteria

- [x] **Scenario: existing configs keep working**
  - **Given** a `tachyon.yml` with both `agents:` and `terminals:` entries
  - **When** Tachyon parses, lists, starts, stops, and restarts those entries
  - **Then** behavior is unchanged, including kind inference, attention defaults, terminal grouping, and legacy `agents:` entries with `kind: terminal`
- [x] **Scenario: MCP compatibility is preserved**
  - **Given** an agent using existing Bridge tools such as `list_agents`, `spawn_agent`, `kill_agent`, `read_output`, and `write_input`
  - **When** the managed-entry terminology lands
  - **Then** those tools still exist and behave compatibly, while any new neutral aliases are additive
- [x] **Scenario: AI-only operations stay AI-only**
  - **Given** an entry whose `kind` is `terminal`
  - **When** AI-specific actions are evaluated, such as role re-anchor, activity transcript, harness, continuity, fork, or delegation-contract gating
  - **Then** the UI/API continues to suppress or reject those actions as terminal-inapplicable
- [x] Internal code has a neutral canonical umbrella type/name for the combined set, and `AgentDef` / `AgentInfo` remain compatibility aliases for that umbrella in this release.
- [x] Docs no longer require readers to interpret engine/API `agent` as "managed entry" except in explicit backwards-compatibility notes.
- [x] The term `session` is not used as the primary umbrella term; docs distinguish managed entries from tmux sessions and runtime resume/conversation sessions.

## Non-goals

- No removal of `agents:` from `tachyon.yml`.
- No removal of existing MCP tool names in this release.
- No additive MCP alias tools in v1; `list_entries` / `spawn_entry` style names require a later deprecation strategy, because adding them permanently expands the public surface.
- No rename of VS Code command IDs such as `tachyon.openAgentTerminal`, `tachyon.restartAgent`, or `tachyon.newAgent` in this release.
- No broad user-facing rebrand of Agent Studio.
- No migration of `.tachyon/sessions.json` or runtime resume semantics.
- No behavior change to tmux lifecycle, crash detection, attention, worktrees, pipelines, or plugin materialization.

## Open questions

- Should the neutral code term be `ManagedEntry`, `RuntimeEntry`, or `ManagedProcess`? Current recommendation: `ManagedEntry` for config/list rows and `ManagedProcess` only where process lifecycle is specifically meant.
