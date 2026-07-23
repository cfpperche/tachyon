# 428 — Agent capability projections — plan

_Drafted from `spec.md` on 2026-07-22._

## Approach

Extend the existing profile reference contract instead of introducing a second capability registry. Typed selectors in `agent.yml` point at pinned source references. A focused capability resolver reads and validates those payloads, joins host-custodied grants, and produces an immutable internal projection object whose digest participates in the resolved profile.

The profile-aware config loader attaches that object to the normalized `AgentDef` only after legacy YAML parsing. The field is internal and cannot be authored in `tachyon.yml`. `Workspace` passes it to `HarnessManager`, which reuses its measured Codex and Pi writers, consumes the captured bytes rather than reopening source paths, rebuilds owned outputs, and atomically writes a secret-free manifest last.

## Key decisions

- **Reuse profile references as selection IDs** — avoids a parallel identity system; rejected implicit directory discovery because filesystem presence is not selection.
- **Keep shared payloads at owner scope** — provenance retains `scope`, `owner`, and `path`; rejected copying shared sources into the canonical agent home because that silently changes ownership.
- **Treat projection metadata as internal launch input** — attach it after config parsing; rejected exposing provenance fields in legacy `tachyon.yml`.
- **Require grants for MCP and executable hooks** — profile declaration expresses desire, not consent; enforcement grants bind the exact hook class.
- **Reuse current runtime writers** — capability semantics are resolved once, while adapters continue owning native serialization.
- **Captured-byte projection** — adapters consume immutable in-memory snapshots produced by the resolver; rejected path re-reads because validation and consumption could observe different bytes.
- **Bounded activation matrix** — Codex skills/MCP/hooks and Pi explicit resources only; rejected enabling every legacy harness adapter because those canonical native-input contracts are not yet measured.
- **Manifest-last rematerialization** — stale owned outputs are rebuilt synchronously before a fresh launch and the manifest is emitted only after success; rejected adopting runtime-home edits.

## Files touched

- `src/config/agentProfileSchema.ts` — typed Pi selectors and hook classification/reference contract.
- `src/config/agentProfileAuthority.ts` — optional host-custodied capability grants.
- `src/config/agentProfileResolver.ts` — resolved capability snapshot, diagnostics, provenance, and digest binding.
- `src/config/agentCapabilityProjection.ts` — safe payload resolution, collision checks, authority join, and internal projection model.
- `src/config/agentProfileProjection.ts` — remove the capability blocker and return projected harness input.
- `src/config/agentProfileConfigLoader.ts` / `src/config/loadConfig.ts` — attach profile-only internal projection metadata after legacy parsing.
- `src/workspace/Workspace.ts` / `src/harness/HarnessManager.ts` — consume the resolved snapshot and write/verify the projection manifest.
- focused unit/integration tests — schema, authority, path custody, collisions, adapter mapping, tamper/rematerialization, and plugin compatibility.

## Risks & unknowns

- Tree capture must be deterministic, bounded, no-follow, and must reject a source revision change while its bytes are being captured.
- Existing runtime config writers merge different ambient inputs. Profile projections must use `inherit: none` and must not erase the separately injected Tachyon Bridge.
- Hook payload shapes differ by runtime. Reject unsupported mappings rather than approximating them.
- Pi activation must reuse the exact-resource isolation and content-addressed generation contract from SDD 406 rather than introducing a parallel Pi path.

## Visual impact

None. This is a configuration/resolution/runtime-home change with no UI surface.

## Sources consulted

- `docs/specs/423-agent-profile-contract/spec.md`
- `docs/specs/406-pi-harness-resources/spec.md`
- `.tachyon/reports/agent-persistent-formation-inventory-2026-07-21.md`
- `src/config/agentProfile{Schema,Resolver,Projection,Authority}.ts`
- `src/config/loadConfig.ts`
- `src/harness/HarnessManager.ts`
