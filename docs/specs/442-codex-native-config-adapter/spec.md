# 442 — codex-native-config-adapter

_Created 2026-07-23._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Canonical Codex agents have a private `CODEX_HOME`, but currently suppress all native configuration.
That preserves isolation while dropping observable behavior such as model/reasoning selection,
approval and sandbox posture, personality/status line, hooks and feature choices.

This spec adds the Codex adapter behind the common native-configuration policy. It projects only
measured, allowlisted families into the private home, keeps authentication external, and rebuilds
the projection on supported lifecycle paths. Unsupported source/family/key combinations fail closed;
Tachyon never copies a whole `config.toml`.

Affected Product Invariants: **none** — this is an opt-in adapter projection for new canonical agents.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [ ] **Scenario: typed agent selectors survive private-home isolation**
  - **Given** a canonical Codex profile whose `selectors` policy chooses `source: agent`
  - **When** Tachyon starts or resumes the agent
  - **Then** the private `CODEX_HOME/config.toml` contains only the profile's model, provider,
    reasoning-effort and service-tier selectors plus Tachyon-owned projection data
- [ ] **Scenario: selected global or workspace family is filtered**
  - **Given** a supported family policy choosing a global or workspace source
  - **When** Tachyon reads that source
  - **Then** only the adapter's reviewed keys for that family are projected and missing keys use
    Codex defaults rather than falling through to another source
- [ ] **Scenario: unsupported or mixed policy fails closed**
  - **Given** one or more authored Codex policy tuples
  - **When** any tuple, source or source key is unsupported
  - **Then** the whole projection is rejected with family/source/key diagnostics and no partial home
- [ ] **Scenario: projection is lifecycle-consistent**
  - **Given** an accepted Codex policy
  - **When** the agent starts fresh, restarts or resumes
  - **Then** Tachyon regenerates the same policy projection before launch; fork remains unsupported
- [ ] Authentication stays externally linked and no credential, token, runtime state, notices,
  trust cache, hook trust state or memory bytes enter canonical policy or generated config.
- [ ] Agent Studio exposes policy and content-free provenance, never source TOML bytes.
- [ ] The Codex row in `docs/runtimes/parity.md` names evidence per shipped family.

## Non-goals

- Migrate or resume legacy agents under the new policy.
- Implement runtime-managed memory (`t-d4c42e`) or Tachyon plugin scope.
- Mirror the full upstream Codex configuration schema in `agent.yml`.
- Copy global or workspace TOML wholesale.
- Support Codex fork, which the measured runtime adapter does not expose.

## Open questions

- The first scalar allowlist requires human review before the global/workspace slice lands.
- Agent-sourced permissions/interface/feature flags remain unsupported until their authority model is
  explicitly decided; the typed selector fields are the only safe agent source in the first slice.
