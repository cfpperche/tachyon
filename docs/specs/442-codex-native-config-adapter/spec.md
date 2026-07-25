# 442 — codex-native-config-adapter

_Created 2026-07-23._

**Status:** shipped
**Closure:** t-1a3d50 closes lifecycle parity with a fresh/restart/resume private-home regeneration proof and a 2026-07-25 Dev Host smoke; lifecycle evidence `4e3b45bd`.
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

- [x] **Scenario: typed agent selectors survive private-home isolation**
  - **Given** a canonical Codex profile whose `selectors` policy chooses `source: agent`
  - **When** Tachyon starts or resumes the agent
  - **Then** the private `CODEX_HOME/config.toml` contains only the profile's model, provider,
    reasoning-effort and service-tier selectors plus Tachyon-owned projection data
- [x] **Scenario: selected global or workspace family is filtered**
  - **Given** a supported family policy choosing a global or workspace source
  - **When** Tachyon reads that source
  - **Then** only the adapter's reviewed keys for that family are projected and missing keys use
    Codex defaults rather than falling through to another source
- [x] **Scenario: unsupported or mixed policy fails closed**
  - **Given** one or more authored Codex policy tuples
  - **When** any tuple, source or source key is unsupported
  - **Then** the whole projection is rejected with family/source/key diagnostics and no partial home
- [x] **Scenario: projection is lifecycle-consistent**
  - **Given** an accepted Codex policy
  - **When** the agent starts fresh, restarts or resumes
  - **Then** Tachyon regenerates the same policy projection before launch; fork remains unsupported
- [x] Authentication stays externally linked and no credential, token, runtime state, notices,
  trust cache, hook trust state or memory bytes enter canonical policy or generated config.
- [x] Agent Studio exposes policy and content-free provenance, never source TOML bytes.
- [x] **Scenario: a human composes runtime tooling by source**
  - **Given** hooks, MCPs, skills or native extensions discovered at global, workspace or agent scope
  - **When** the human enables or disables one available item for a canonical agent
  - **Then** the agent profile persists that selection, the private runtime harness receives the
    resulting effective composition, and Agent Studio shows both each contributing source and the
    effective set at any later time
- [x] The Codex row in `docs/runtimes/parity.md` names evidence per shipped family.

## Non-goals

- Migrate or resume legacy agents under the new policy.
- Implement runtime-managed memory (`t-d4c42e`) or Tachyon plugin scope.
- Mirror the full upstream Codex configuration schema in `agent.yml`.
- Copy global or workspace TOML wholesale.
- Support Codex fork, which the measured runtime adapter does not expose.
- Treat a human-enabled hook, MCP or skill as an approval workflow or attempt to infer whether the
  human should accept its risk. The product must make the composition visible; the human decides.

## Open questions

None for the shipped scope. Agent-sourced permissions/interface/feature flags and native extensions
remain explicitly unsupported rather than implied future compatibility.
