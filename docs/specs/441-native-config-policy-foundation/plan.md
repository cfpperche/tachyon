# 441 — native-config-policy-foundation — plan

_Drafted from `spec.md` on 2026-07-23. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add closed enums and a family-keyed policy map to `agentProfileSchemaV1`. Add a registry-neutral
validation/provenance module whose support catalog is empty in this foundation slice; adapter slices
will add declarations. Canonical projection rejects requested entries not present in that catalog.

Agent Studio mutations round-trip authored policy and snapshots expose a content-free preview. The UI
renders one compact read-only section with source, treatment, refresh, lifecycle and support. Editing
controls become enabled only when adapter slices publish supported combinations.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Family-scoped map** — avoids one misleading inherit boolean.
- **Closed common vocabulary, adapter-owned support** — shares intent without pretending runtime protocols are identical.
- **Fail closed before materialization** — prevents accepted profile state that silently changes behavior.
- **Content-free provenance** — Studio may explain origin and lifecycle but never receive raw config, credentials or runtime state.

## Files touched

- `src/config/agentProfileSchema.ts` — authored policy contract.
- `src/config/agentNativeConfigPolicy.ts` — vocabulary, support validation and provenance.
- `src/config/agentProfileProjection.ts` — projection admission.
- `src/config/agentProfileStudio.ts` — mutation and snapshot contract.
- `src/webview/agent-studio-shell/*` — compact provenance display.
- Focused schema/projection/Studio tests.

## Risks & unknowns

- Empty adapter support must not affect profiles that omit the new field.
- Studio edits must preserve unrelated canonical bindings.
- A generic catalog must not become a second runtime adapter registry.

## Visual impact

Canonical Agent Studio gains a compact “Native configuration” section. Verify wrapping and empty-state
copy in the existing dark Dev Host surface.

## Sources consulted

- `docs/architecture/agent-native-config-inheritance.md`
- `docs/runtimes/parity.md`
- `src/config/agentProfileSchema.ts`
- `src/config/agentProfileProjection.ts`
- `src/config/agentProfileStudio.ts`
- `src/webview/agent-studio-shell/App.tsx`

## Hardening amendment — t-e05e00

The empty catalog remains the production default, but support is now a closed
`supported | unsupported` decision over the exact policy tuple. Validation rejects
the complete projection when any authored tuple is unsupported. A synthetic resolver
tests the extension seam without shipping a fake runtime materializer.
