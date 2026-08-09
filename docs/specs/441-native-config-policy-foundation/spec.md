# 441 — native-config-policy-foundation

_Created 2026-07-23._

**Status:** shipped
**Closure:** shared schema, fail-closed projection admission, canonical Studio round-trip and content-free provenance shipped in task `t-96ebad`; task `t-e05e00` hardened the adapter support seam and mixed-support contract before the first adapter slice.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Verify:** `npx vitest run test/unit/agentNativeConfigPolicy.test.ts test/unit/agentProfileConfigLoader.test.ts test/unit/agentProfileStudio.test.ts test/unit/agentStudioDomain.test.ts`

## Intent

Canonical profiles have no common contract for selecting runtime-native configuration. Adapters
currently copy, merge or exclude global/workspace files through unrelated rules, so a private home
can silently lose observable behavior.

This slice adds the shared authored vocabulary and read-only Studio provenance defined by
`docs/architecture/agent-native-config-inheritance.md`. It does not materialize any runtime-specific
configuration. Until a later adapter slice declares support, authored native policy fails closed.

Affected Product Invariants: **none** — this introduces an opt-in canonical contract without changing
existing launch behavior.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: native policy round-trips canonically**
  - **Given** a canonical profile with family-scoped native policy
  - **When** the profile is parsed, exported or projected into Agent Studio
  - **Then** source, treatment, refresh and lifecycle remain explicit without raw runtime-file bytes
- [x] **Scenario: unsupported policy fails closed**
  - **Given** an adapter with no declared support for a requested family/policy combination
  - **When** canonical projection runs
  - **Then** projection returns an actionable unsupported-policy diagnostic
- [x] **Scenario: Studio explains provenance**
  - **Given** a canonical profile
  - **When** Agent Studio displays native configuration
  - **Then** it shows each family’s authored choice, support state and projection lifecycle without exposing secrets or mutable runtime state
- [x] Existing profiles without native policy retain byte-compatible behavior.
- [x] Memory, plugins, credentials, transcripts, caches and runtime state are not absorbed into the authored policy.
- [x] Adapter support decisions evaluate the exact family/source/treatment/refresh/lifecycle tuple.
- [x] Any unsupported authored tuple rejects the whole projection; supported tuples are never partially applied.
- [x] Omitted and empty native policy are equivalent no-policy states.

## Non-goals

- Implement Codex, Claude, Grok, OpenCode, Pi or Hermes materializers.
- Migrate existing legacy agents.
- Redesign runtime-managed memory or Tachyon plugin scope.
- Parse arbitrary native configuration files.

## Open questions

None. Adapter-specific supported combinations belong to the named follow-up tasks.
