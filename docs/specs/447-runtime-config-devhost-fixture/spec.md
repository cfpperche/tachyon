# 447 — runtime-config-devhost-fixture

_Created 2026-07-24._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Runtime Config needs repeatable human validation without showing or modifying a real
`~/.codex/config.toml`. The existing fixture covers a workspace file only; its Global view remains
ambient machine state, so it cannot safely prove source scope, preservation or stale-write behavior.

Done means a dedicated Dev Host fixture provides both controlled Codex sources and intentionally
contrasting data. A human can validate the viewer and editor against it, while production and an
installed VS Code window keep using the real global home unchanged.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [ ] **Scenario: inspect controlled Global and Workspace sources**
  - **Given** the SDD 447 fixture is armed through the normal F5 Dev Host pointer
  - **When** the human selects Global or Workspace in Runtime Config
  - **Then** each view shows its fixture-owned path, distinct measured values, named test MCPs and
    preserved unknown/hook-state evidence; no real `~/.codex/config.toml` is read or written
- [ ] **Scenario: edit and preserve fixture data**
  - **Given** either parseable fixture source
  - **When** the human changes a measured scalar or disables one test MCP
  - **Then** only that entry changes; comments, unknown keys, runtime-managed hook state and the
    other MCP remain intact
- [ ] The fixture includes stopped Codex agents for source inspection and a documented future
      running-agent case for Slice C; it never starts a real Codex CLI merely to test this view.

## Non-goals

- Recreate the user's complete Codex home or use real credentials, commands or MCP endpoints.
- Validate Claude, Grok, skills, hooks or extensions that Runtime Config has not yet measured.
- Implement Slice C pending/restart lifecycle behavior.

## Open questions

- Whether the future Slice C fixture needs a fake running process or can use a controlled lifecycle
  seam. Owner: Slice C implementation.
