# 462 — claude-profile-capabilities

_Created 2026-07-25._

**Status:** shipped
**Closure:** Shipped under `t-2f37e7`: Claude grant/capture resolution for skills, hooks and MCP,
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
combined private-home materialization with reserved Bridge and manifest-last provenance, lifecycle
regression, and parity evidence.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Canonical Claude profiles must consume only capabilities explicitly selected by the profile, captured
by the owning scope, and authorized by an exact host-custodied grant. Add Claude-native projection for
skills, hooks and MCP without reopening ambient `.claude` or `.mcp.json` discovery.

Materialization combines these capabilities with the closed native-settings projection, external
auth/bootstrap, exact trust and the reserved Tachyon Bridge in one regenerable private-home generation.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: authorized Claude capabilities**
  - **Given** a canonical Claude profile selecting captured skill, hook and MCP references with exact Claude grants
  - **When** the profile resolves and launches
  - **Then** only those captured bytes are projected into its private home alongside the reserved Bridge, and a manifest records their provenance
- [x] **Scenario: fail closed on missing or mismatched authority**
  - **Given** a selected capability without a matching Claude grant, with invalid Claude hook structure, or colliding with `tachyon_bridge`
  - **When** the profile resolves
  - **Then** projection fails before launch without materializing ambient substitutes
- [x] **Scenario: lifecycle regeneration**
  - **Given** stale private skills, hooks or MCP from a prior run
  - **When** fresh, restart or resume materializes the canonical Claude profile
  - **Then** all three paths regenerate the same selected capabilities and remove stale authority
- [x] `docs/runtimes/parity.md` records the measured support and remaining fork limitation.

## Non-goals

- Ambient workspace skill/MCP inheritance, plugin projection, arbitrary raw settings, or account-home sharing.
- Claude private-home fork support (`t-088454`) and runtime-managed memory (`t-d4c42e`).
- Changing existing Codex or Pi grant requirements.

## Open questions

None. The runtime-specific hook parser and existing capability capture format answer the implementation boundary.
