# 447 — runtime-config-devhost-fixture — plan

_Drafted from `spec.md` on 2026-07-24. The approach, not the steps (those go in `tasks.md`)._

## Approach

Keep fixture data under `test/fixtures/runtime-config-devhost-fixture/`. Add a Dev Host-only
environment override for Runtime Config's global source: the pointer seeds an isolated profile home
from the fixture and the extension passes that home only while `TACHYON_DEV_HOST=1`. The same
profile home is already the native-profile inspection home, so the visual reader and canonical
projection observe one controlled source.

Populate separate global/workspace TOML files with all six measured values, comments, unknown keys,
multiple inert MCP blocks and `hooks.state` values. Document a compact manual scenario in the
fixture README. Add unit coverage for the home selection, keeping production's `os.homedir()` path.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Dev Host profile home is the fixture global source** — it is isolated by the existing F5
  launch environment; rejected changing HOME because that has broad unrelated process effects.
- **Inert MCP definitions** — names and harmless commands prove targeted removal; rejected real
  servers because Runtime Config must not need network or spawned processes to be verified.

## Files touched

- `src/extension.ts` — select the Dev Host profile home for Runtime Config only in Dev Host mode.
- `scripts/dev-host/pointer.mjs` — materialize the fixture's controlled global home into the pointer.
- `test/fixtures/runtime-config-devhost-fixture/*` — global source seed, workspace source and walkthrough.
- `test/unit/*` — selection/fixture-preservation regression coverage.

## Risks & unknowns

- A pointer rearm must refresh the controlled global source rather than retain an edited prior run.
- The override must never apply to an installed/non-Dev-Host extension.

## Visual impact

The existing Runtime Config view should show obvious Global/Workspace provenance and contrast. A
human Dev Host pass will capture both states after implementation.

## Sources consulted

- `docs/specs/446-runtime-config-control/*`
- `src/workspace/Workspace.ts` (`TACHYON_DEV_HOST_PROFILE_HOME`)
- `src/config/agentProfileProjection.ts`
- `scripts/dev-host/pointer.mjs`
