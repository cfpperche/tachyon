# 442 — codex-native-config-adapter — plan

_Drafted from `spec.md` on 2026-07-23. The approach, not the steps (those go in `tasks.md`)._

## Approach

Ship the adapter in independently reviewable slices:

1. Project typed profile selectors from `source: agent` into a generated private Codex config.
2. Parse global/workspace config with a deny-by-default per-family allowlist for permissions,
   interface and feature flags.
3. Add human-configurable tooling composition for hooks, MCPs, skills and native extensions. Each
   item can be selected from global, workspace or agent scope; persist those selections in the
   agent profile, materialize the effective set in its private runtime harness, and expose both
   source inventory and effective composition in Agent Studio. This does not absorb Tachyon plugin
   ownership.
4. Prove fresh/restart/resume behavior and update the parity matrix.

The common support resolver declares exact tuples. The chosen source owns its whole family: missing
keys use Codex defaults and never fall through to another source. Projection is assembled in memory,
written atomically into the private home, and regenerated before every supported launch path.

Slice C is split at its trust boundaries: `t-2b258a` composes the already-authoritative captured
capabilities with the native scalar projection in one private Codex home; `t-c9a086` measures and
defines safe global/workspace/profile tooling discovery; `t-115742` adds the resulting Studio controls.
Native extensions remain unavailable until the measurement proves an agent-scoped mechanism that does
not re-scope Tachyon's workspace-wide plugins.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Typed selectors first** — existing canonical fields already have authority and avoid new source
  bytes; rejected a general agent TOML sidecar because it creates a second source of truth.
- **Single source per family** — preserves the authored policy; rejected implicit
  global→workspace→agent fallback because it silently changes provenance.
- **Deny-by-default key tables** — makes upstream Codex additions unsupported until measured;
  rejected whole-file copying because it leaks state, trust and credentials.
- **Whole-projection admission** — one unsupported tuple/key blocks all writes; rejected partial
  materialization because the resulting behavior would not match the profile.
- **Human-owned tooling choice** — the Studio must let a human enable or disable available global,
  workspace and agent-scoped hooks/MCPs/skills/extensions for an agent, then show the effective
  result. Rejected a policy engine that attempts to classify or approve the human's risk decision;
  the product provides explicit composition and visibility instead.
- **Separate tooling slice** — hooks/MCPs/skills/extensions have different file shapes from scalar
  config; rejected one giant parser/materializer change.

## Files touched

- `src/config/agentNativeConfigPolicy.ts` — Codex exact support declarations.
- `src/config/agentProfileProjection.ts` — validate and carry a content-free Codex projection.
- `src/config/loadConfig.ts` — internal projected native-config launch contract.
- `src/harness/HarnessManager.ts` — atomic private `CODEX_HOME` materialization.
- `src/workspace/Workspace.ts` — route canonical Codex launches through the materializer.
- `docs/runtimes/parity.md` — per-family evidence.
- Focused profile, harness and lifecycle tests.

## Risks & unknowns

- Codex configuration evolves; unknown keys must remain denied.
- Project config is loaded only for trusted repos; Tachyon must not bypass that boundary accidentally.
- Provider and credential configuration can carry authority or secret references and must remain external.
- Resume uses the same launch materializer today; tests must pin it rather than assume it.
- Global/workspace TOML needs a real parser before scalar inheritance; a regex parser is not acceptable.

## Visual impact

Slice C adds Agent Studio composition controls and an always-visible inventory. For every tooling
kind, the surface must show: available global/workspace/agent sources, the human's enabled/disabled
choice, and the resulting effective composition. It is not merely a read-only provenance surface.
Verify this in installed dogfood, not with the excluded beta desktop harness.

## Sources consulted

- `docs/architecture/agent-native-config-inheritance.md`
- `docs/runtimes/parity.md`
- `docs/specs/441-native-config-policy-foundation/*`
- `src/config/agentNativeConfigPolicy.ts`
- `src/config/agentProfileProjection.ts`
- `src/harness/HarnessManager.ts`
- `src/workspace/Workspace.ts`
- OpenAI Codex Manual, configuration basics/advanced/reference and hooks sections, refreshed 2026-07-23
- Claude Fable adversarial review `probe-79da5bb4-42df-4b4a-accf-8b9d32df8ccc`
