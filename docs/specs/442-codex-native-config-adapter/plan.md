# 442 — codex-native-config-adapter — plan

_Drafted from `spec.md` on 2026-07-23. The approach, not the steps (those go in `tasks.md`)._

## Approach

Ship the adapter in independently reviewable slices:

1. Project typed profile selectors from `source: agent` into a generated private Codex config.
2. Parse global/workspace config with a deny-by-default per-family allowlist for permissions,
   interface and feature flags.
3. Add tooling projection for hooks, MCP, skills and native extensions without absorbing Tachyon
   plugin ownership.
4. Prove fresh/restart/resume behavior and update the parity matrix.

The common support resolver declares exact tuples. The chosen source owns its whole family: missing
keys use Codex defaults and never fall through to another source. Projection is assembled in memory,
written atomically into the private home, and regenerated before every supported launch path.

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
- **Separate tooling slice** — hooks/MCP/skills/extensions have different trust and file shapes from
  scalar config; rejected one giant parser/materializer change.

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

No new editing controls in the first slice. Existing read-only policy/provenance rows may show
`Supported`; verify this in the first installed adapter dogfood, not with the excluded beta desktop harness.

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
