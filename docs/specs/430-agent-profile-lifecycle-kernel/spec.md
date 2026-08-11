# 430 — Agent profile lifecycle kernel

_Created 2026-07-22._

**Status:** shipped
**Closure:** Landed in commit `ebc21e7c` for task `t-f447c4`; all acceptance and verification tasks are checked.
**Status detail:** implemented

**Task:** `t-f447c4` · **Parent:** `t-e50d4f` / SDD 429

**Affected Product Invariants: none —** PI-001 concerns project-guidance ownership and its promise/oracle remain unchanged. This slice runs the invariant gate but does not edit its evidence.

## Intent

Profile-backed agents launch from `.tachyon/agents/<agent>/agent.yml`, yet there is no general mutation boundary for that file. The migration path can publish an initial profile, but Agent Studio still writes legacy YAML and no revision token binds a human edit to the exact canonical and authority inputs they inspected. A crash between profile, SecretStorage authority and `tachyon.yml` locator writes can therefore leave an ambiguous identity.

This slice introduces the host-owned lifecycle kernel for safe profile inspection and the non-identity-changing operations: create, edit and enable/disable. It publishes redacted revisioned snapshots, accepts structured intents only, serializes mutations per agent, journals every multi-store transition and reconciles incomplete transactions before profile-aware configuration is loaded.

## Canonical enablement

`agent.yml.lifecycle.enabled` is the sole persisted enablement value for a profile-backed agent. Absence means enabled for compatibility. The field is projected into private in-memory launch metadata, cannot be authored through a legacy `tachyon.yml` stanza, and is checked by every AgentManager spawn entry before any runtime home/session is created. Disabled agents remain listed and inspectable.

## Revision and patch contract

The opaque revision binds a canonicalization version, the exact canonical `agent.yml` bytes, versioned canonical profile authority envelope, unambiguous `tachyon.yml` pointer stanza and the absence of an active lifecycle transaction. Under the shared per-agent lock the kernel re-reads that tuple, verifies the supplied revision and durably creates intent before publication. A mutation supplies an explicit allowlisted canonical patch, not a resolved form or authority payload. The kernel rejects changes to `agentId`, agent locator/name, authority records, grants or secret values. Derived/resolved, learned and projected values are not inputs to the write API.

Inspection returns section-level provenance and writability for canonical, learned, projection and authority lanes, plus redacted diagnostics. It may report that a lane exists without returning authority secrets or runtime-secret values.

## Transaction protocol

The existing profile-migration coordinator, root and recovery entry point are generalized rather than duplicated. Migration becomes another operation type under the same per-agent lock and authority CAS. One transaction ID and lock govern these durable phases:

1. `intent` — journal, before-state digests and exact target bytes are durable outside the agent root; launch is blocked.
2. `staged` — target profile and resulting authority record validate and are fsynced.
3. `profile-published` — canonical bytes are atomically replaced.
4. `authority-published` — the exclusive SecretStorage authority port conditionally replaces the exact prior version with a transaction-tagged target envelope and verifies readback; grants are copied from current authority under lock, never accepted from the patch.
5. `locator-written` — create only: the exact canonical pointer stanza is committed through a no-follow whole-file CAS.
6. `activated` — the host reloads the proven tuple while the durable journal still blocks launch; recovery may repeat this idempotently.
7. `committed` — readback and host activation agree; only now may launch resume.

Every resource records an unambiguous absent (`null`) or present before/target state plus transaction identity. Recovery runs before profile discovery and any spawn-capable service. If every target state is present it activates and completes the journal; otherwise it restores/removes only resources still carrying a known before/target state and reactivates that prior state. Unknown divergence becomes `degraded`, keeps launch blocked and exposes diagnostics; it is never guessed through. Repeating activation or a completed intent is idempotent.

## Acceptance criteria

- [x] **Scenario: canonical create commits all stores**
  - **Given** a free agent name, valid target profile and no authority/locator
  - **When** create commits
  - **Then** profile bytes, host authority and exact `tachyon.yml` pointer agree before the agent becomes launchable
- [x] **Scenario: edit is revision checked**
  - **Given** two readers inspect the same profile
  - **When** one commits and the other submits its stale revision
  - **Then** the stale edit changes nothing and receives a redacted conflict
- [x] **Scenario: externally owned lanes are not rewritten**
  - **Given** learned, projection, grants or secret-reference authority accompanies a profile
  - **When** a canonical edit commits
  - **Then** only allowed `agent.yml` fields change, valid authority metadata is preserved, and no derived value is promoted into canonical bytes
- [x] **Scenario: disabled profiles cannot launch**
  - **Given** `lifecycle.enabled: false`
  - **When** manual, autostart, pipeline or Bridge spawn reaches AgentManager
  - **Then** it fails before runtime-home/session creation while Studio inspection remains available
- [x] **Scenario: incomplete transactions recover deterministically**
  - **Given** failure after each durable phase
  - **When** startup reconciliation runs
  - **Then** it proves and finishes the target, restores the exact prior state, or marks degraded and blocks launch
- [x] Symlink/path replacement, malformed journals, concurrent writers, authority readback mismatch and changed locator stanza fail closed.
- [x] Legacy inline agents and profile migration/rollback remain compatible; legacy YAML cannot author profile-only enablement metadata.

## Non-goals

- Rename, forget or name reuse (`t-c111e4`).
- Clone, import or export (`t-999e4f`).
- Agent Studio UI/protocol (`t-149877`).
- Plugin scope, runtime-managed memory or raw canonical YAML editing.

## Open questions

None. The independent review requires migration to use the generalized coordinator in this slice.
