# 460 — claude-native-config-inheritance

_Created 2026-07-25._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Canonical Claude agents already use a private `CLAUDE_CONFIG_DIR`, but the projection is an implicit
merge of workspace settings, local settings, skills and MCP. It is not represented as a declared
per-family policy, and it can silently relocate executable or permission-bearing settings into the
private user-tier home.

Make supported Claude inheritance explicit, selective and lifecycle-consistent. The unit of
authorship is an allowlisted setting key or a validated capability reference — never an entire
`settings.json` file. Global roots, credentials, trust/bootstrap, runtime memory and undeclared
executable surfaces remain outside profile authoring.

**Affected Product Invariants:** none — adapter projection for canonical agents.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [ ] **Scenario: declared Claude setting projection**
  - **Given** a canonical Claude profile selecting a supported workspace setting family
  - **When** it is started, restarted, resumed or forked
  - **Then** only the measured, allowlisted non-executable settings are regenerated identically in
    its private projection, with unsupported keys excluded and diagnosed.
- [ ] **Scenario: capability projection remains explicit**
  - **Given** a canonical Claude profile with approved MCP or skill capabilities
  - **When** its private home is materialized
  - **Then** the capability projection is validated, refreshed atomically with its generation, and
    cannot acquire ambient commands, agents, plugins or credentials.
- [ ] Workspace `settings.local.json`, global settings, auth/bootstrap, exact trust, auto-memory and
  runtime-owned state have explicit non-authoring dispositions.
- [ ] Fresh/restart/resume/fork evidence and `docs/runtimes/parity.md` name the actual supported
  family/source/treatment/refresh/lifecycle tuples.

## Non-goals

- Implement runtime-managed memory (`t-d4c42e`) or copy credentials/runtime state into a profile.
- Expose raw Claude settings JSON, plugin roots, arbitrary hooks, commands or agents in Agent Studio.
- Claim that a requested provider model or an upstream setting is supported without measurement.

## Open questions

The exact allowlist and valid Claude `modelUsage`/setting schema must be measured against the pinned
Claude CLI before implementation; unknown keys remain excluded rather than accepted by default.
