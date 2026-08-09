# 449 — canonical-codex-native-policy-authoring

_Created 2026-07-25._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Canonical Codex agents isolate `CODEX_HOME`, but Agent Studio currently saves new profiles with no
native-configuration policy. The private home therefore drops measured global behavior such as
`approval_policy`, sandbox posture, personality/status line and terminal reflow. Runtime Config can
show the global values and list the agent as a potential consumer while the launched agent silently
uses Codex defaults.

**Affected Product Invariants:** none — this closes a profile-authoring gap and does not change either
registered project-guidance ownership or worktree-cleanup safety promise.

Agent Studio must author the already-supported Codex scalar-family policy. New Codex profiles default
to filtered global defaults, while the human can explicitly exclude a family or select workspace
defaults. The existing deny-by-default projector remains the only path to the private home.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: new Codex preserves measured global defaults**
  - **Given** global Codex config contains `approval_policy = "never"` and other measured scalar keys
  - **When** a human creates a canonical Codex agent with the default Agent Studio choices
  - **Then** its profile authors global policies for permissions, interface and feature flags, and
    its generated private config contains only the measured keys
- [x] **Scenario: source selection is explicit and round-trips**
  - **Given** a new or existing canonical Codex profile
  - **When** the human selects Exclude, Global or Workspace for a supported scalar family and saves
  - **Then** Agent Studio reloads the same choice and provenance names the selected source
- [x] **Scenario: another runtime does not inherit Codex policy**
  - **Given** the New Agent form starts with Codex defaults
  - **When** the human creates a supported non-Codex canonical runtime
  - **Then** the save payload omits the Codex-native policy
- [x] Only the exact tuples already admitted by the Codex adapter are authored:
  `overlay`, `every-launch`, lifecycle `fresh + restart + resume`.
- [x] Raw TOML, tooling, authentication, memory, caches, credentials and unknown keys remain outside
  the profile and private projection.

## Non-goals

- Add support for a new native-config family, source, treatment or lifecycle.
- Copy a complete global/workspace `config.toml`.
- Change Runtime Config itself or reconcile legacy harness UI.
- Migrate existing legacy agents or mutate an existing profile without a Studio save.

## Open questions

None. The supported tuples and trust boundary were ratified by SDD 441/442; this slice closes the
missing authoring path.

**Closure:** Agent Studio now authors the filtered Codex scalar policy explicitly, defaults new Codex
**Verify:** `npx vitest run test/unit/agentStudioAdapter.test.ts test/unit/codexNativeConfigProjection.test.ts`
**Verify:** `npm run typecheck`
**Dogfood:** `node scripts/dev-host/lane.mjs run --owner "$TACHYON_AGENT_NAME" --target worktree -- npm run dogfood -- dev-host -- headless`
profiles to global sources, and strips that policy when creating another runtime.
