# 438 — agent-profile-studio — plan

_Drafted from `spec.md` on 2026-07-22. The approach, not the steps (those go in `tasks.md`)._

## Approach

Keep `t-149877` as the integration umbrella and deliver four ordered slices:

1. `t-fdb422` adds a canonical Studio projection and CAS save path. Canonical load starts from `inspectAgentProfileLifecycle`; save sends a narrow authored patch to `commitAgentProfileLifecycle`. Legacy load/save remains unchanged.
2. `t-293326` adds explicit typed enable/disable, rename and forget actions over the existing transactions.
3. `t-ecd405` adds clone/import/export actions over the existing portable bundle bytes; it never serializes the visible form.
4. `t-fa332a` finishes provenance/diagnostic presentation, localization, accessibility, Visual QA and installed dogfood, then closes this SDD and SDD 429.

Soul and Evolution remain separate domain protocols. The shared Studio host's CAS mechanism is reused; the canonical draft itself carries the expected revision consumed by the adapter save. No child may write canonical agents through `Workspace.studioSubmit` or `YamlConfigEditor`.

## Key decisions

- **Four slices, not one large UI commit** — protocol, destructive lifecycle, byte transport and presentation have distinct rollback and review boundaries.
- **One source per kind of state** — `agent.yml` owns authored inputs; `tachyon.yml` owns only the pointer; authority owns grants; Evolution owns learned state; runtime resolution owns projections; secret storage owns values.
- **Legacy branch remains explicit** — profile-backed agents use canonical services, other agents retain current behavior.
- **Conflict means stop and refresh** — no automatic merge or hidden retry in V1.
- **Reuse existing operations literally** — Studio is orchestration/presentation, not a new profile service.

## Files touched

- This umbrella changes only SDD/task decomposition.
- Child slices own adapter/domain/protocol, Workspace service seams, Agent Studio shell/CSS/localization and focused tests.

## Risks & unknowns

- `FormState` contains many legacy/derived fields; the first slice must introduce a discriminated canonical draft rather than making the whole legacy shape writable.
- The generic Studio CAS display exists, but the canonical patch must still retain the expected revision through save.
- Visual and installed proof cannot be claimed by headless tests and belongs only to the closing slice.

## Visual impact

The closing slice adds provenance/authority badges, disabled/degraded/conflict states and a lifecycle action hierarchy. It requires dark, light and high-contrast inspection.

## Sources consulted

- SDD 429, canonical lifecycle/rename/forget/bundle services, Agent Studio adapter/domain/shared host contracts.
- Architecture review `probe-ba265098-ea19-4b80-9f94-8b08fb7ea578` (full result under `.tachyon/probes/`).
