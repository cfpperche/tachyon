# 311 — codex-harness-instructions-skills-hooks

_Created 2026-07-01._

**Status:** shipped
**Closure:** Shipped Codex harness instructions/skills/hooks materialization on 2026-07-01. Codex now supports `harness.instructions` -> private `CODEX_HOME/AGENTS.md`, `harness.skills` -> private `CODEX_HOME/skills`, and `harness.hooks` -> native `config.toml` hook keys; `rules` remains Claude-only.

## Intent

Codex isolated harness currently supports only MCP/config/transcript isolation. That is honest but incomplete: Codex
has native mechanisms for persistent instructions (`AGENTS.md` under `CODEX_HOME`), skills (`CODEX_HOME/skills/<name>`),
and lifecycle hooks (`hooks.<Event>` in `config.toml`). Tachyon should expose these as Codex-native harness capabilities
instead of pretending Claude `rules` map 1:1 to Codex.

Done means a Codex harness can declare `instructions`, `skills`, and `hooks` in addition to `mcp`; Tachyon materializes
them into the private `CODEX_HOME`; old Claude behavior stays unchanged; and the UI stops presenting Codex as MCP-only.

## Acceptance criteria

- [x] **Scenario: Codex harness instructions**
  - **Given** a Codex agent with `harness.instructions` pointing at one or more workspace markdown files
  - **When** Tachyon materializes the harness
  - **Then** the private `CODEX_HOME/AGENTS.md` contains those files, with deterministic section headers, and `codex debug prompt-input` can see the content
- [x] **Scenario: Codex harness skills**
  - **Given** a Codex agent with `harness.skills` pointing at workspace skill directories
  - **When** Tachyon materializes the harness
  - **Then** each skill is copied under `CODEX_HOME/skills/<basename>` and `codex debug prompt-input` lists it as an available skill
- [x] **Scenario: Codex harness hooks**
  - **Given** a Codex agent with `harness.hooks`
  - **When** Tachyon materializes the harness
  - **Then** the private `CODEX_HOME/config.toml` contains a native `hooks` configuration without using Claude `settings.json`
- [x] **Scenario: Codex rules remain unsupported**
  - **Given** a Codex agent with `harness.rules`
  - **When** config validation runs
  - **Then** Tachyon rejects it and asks for `instructions` instead
- [x] Claude harness behavior remains unchanged.

## Non-goals

- Claiming Claude `rules` and Codex `instructions` are the same concept.
- Implementing Codex plugin marketplace installation.
- Proving real hook execution in an authenticated long-running Codex TUI; this spec proves native config materialization
  and keeps a manual dogfood route for hook firing.
- Changing existing agent `instructions:` startup-prompt behavior.

## Open questions

- None currently. Local `codex debug prompt-input` proved `CODEX_HOME/AGENTS.md` and `CODEX_HOME/skills/*/SKILL.md`
  are model-visible.
