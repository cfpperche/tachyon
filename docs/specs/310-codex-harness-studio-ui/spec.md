# 310 — codex-harness-studio-ui

_Created 2026-07-01._

**Status:** shipped
**Closure:** Shipped Agent Studio Codex harness UI materialization on 2026-07-01. Codex now exposes transcript/harness controls, limits the visible harness fields to MCP, and Studio validation blocks unsupported rules/skills/hooks.

**Verify:** `npm test -- --run test/unit/agentStudio.test.ts && npm run typecheck`
**Dogfood:** `npm test -- --run test/unit/agentStudio.test.ts -t "codex"`

## Intent

Spec 298 shipped backend/config support for Codex isolated harness, but Agent Studio still hides the isolation controls
for a `cmd: codex` agent. The form's render gate is still Claude-only, so a human cannot discover or create a Codex
isolated harness from the UI even though the saved config path supports it.

Done means the Agent Studio exposes transcript isolation and isolated harness controls for Codex agents, while keeping
the Codex harness surface honest: Codex supports MCP isolation in this pass, not rules/skills/hooks.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: Codex agent shows isolation controls**
  - **Given** Agent Studio is creating an agent with `cmd: codex`
  - **When** the Agent tab renders
  - **Then** the `Isolate transcript` and `Isolated harness` controls are visible
- [x] **Scenario: Codex harness UI writes supported config**
  - **Given** a Codex agent with isolated harness enabled and an MCP YAML block
  - **When** the form is submitted
  - **Then** the resulting entry contains `harness.mcp` and no unsupported rules/skills/hooks are required
- [x] **Scenario: Codex rules/skills/hooks are not silently accepted in Studio**
  - **Given** a Codex agent with isolated harness enabled
  - **When** rules, skills, or hooks are filled
  - **Then** Studio validation reports a blocking unsupported-capability issue before save
- [x] Claude harness UI behavior remains unchanged.

## Non-goals

- Implementing Codex rules/skills/hooks materialization.
- Changing spec 298 backend harness behavior.
- Redesigning the Agent Studio layout beyond the runtime gate and Codex-specific visibility/validation.

## Open questions

- None currently.
