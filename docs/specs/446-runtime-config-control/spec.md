# 446 — runtime-config-control

_Created 2026-07-24._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Runtimes already own global and project-local configuration, but Control exposes only runtime
operations. A human cannot see which native settings, skills, MCPs, hooks or extensions exist at
either scope, cannot make a deliberate scoped change, and cannot tell which agents will receive it.

Runtime Config makes those native sources visible and manageable without pretending Tachyon owns a
runtime's complete schema. It exposes only measured editable fields and individual discovered
tooling entries, preserves all other source bytes, records whether a running agent still has an
older composition, and applies a saved change on its next Start, Restart or Resume.

Affected Product Invariants: **none** — this is a new opt-in Control surface and native adapter
projection; it does not change an existing fixed external promise.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [ ] **Scenario: inspect one runtime source at a time**
  - **Given** a supported runtime has a global or selected-workspace native configuration source
  - **When** the human opens Control → Runtime Config and selects its scope
  - **Then** the surface shows the exact source path, measured editable settings, discovered
    individual tooling entries, unedited/unknown entries, and agents that can inherit that source
- [ ] **Scenario: change one measured setting or tooling item**
  - **Given** a parseable supported native source
  - **When** the human changes a measured field or enables/disables one individual skill, MCP, hook
    or extension and saves
  - **Then** the canonical native-config adapter atomically updates only that measured entry,
    detects a changed source before writing, preserves unrelated source data, refreshes the
    displayed inventory, and reports any parse/write failure without partial output
- [ ] **Scenario: saved runtime configuration waits for a running agent**
  - **Given** an agent is already running with an earlier runtime composition
  - **When** its selected global or workspace source changes
  - **Then** Control marks that agent configuration-pending; its current session is not interrupted,
    and its next Start, Restart or Resume rebuilds the effective private runtime configuration while
    surfacing the composition delta at the next launch boundary
- [ ] **Scenario: unsupported data remains visible but not falsely editable**
  - **Given** a runtime/source key or tooling form has not been measured for visual editing
  - **When** Runtime Config inventories it
  - **Then** Control shows it as preserved/other data with an open-source-file escape hatch and
    never silently rewrites or drops it
- [ ] Global and workspace sources are distinct in both displayed provenance and saved output.
- [ ] A global write visibly states that it affects runtime processes outside Tachyon too; it is an
      explicit human action, not the default workspace edit path.
- [ ] Runtime Config does not expose credentials, tokens, memory/transcript data, or full source
  content in the general Control model.

## Non-goals

- Reproduce each runtime's full upstream configuration schema.
- Decide whether a human should accept the risk of a hook, MCP, skill or extension.
- Delete capability files when an item is disabled; disabling removes it only from the active source
  configuration.
- Change Tachyon plugin installation or ownership.
- Hot-reload runtime configuration into an existing agent session unless an adapter later measures
  and explicitly declares that capability.
- Migrate legacy agents.

## Open questions

- Which fields and tooling shapes are actually editable for Claude and Grok after their source
  readers are measured. Owner: per-runtime adapter slices.
- How a runtime records an individual native skill/extension as disabled when its upstream format has
  no first-class enable flag. Owner: adapter design; omission from active config is the tentative
  default.
- Exact Resume delta presentation and behavior when a transcript references a capability removed
  since the prior session. Owner: lifecycle Slice C; do not infer equivalence with Start.
