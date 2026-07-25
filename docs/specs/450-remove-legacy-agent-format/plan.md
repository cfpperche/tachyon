# 450 — Remove legacy agent format — plan

_Drafted from `spec.md` on 2026-07-25._

## Approach

1. Move migration-neutral transaction roots, locks, exact file replacement and canonical profile
   publication helpers into `agentProfileTransactions.ts`; update lifecycle, rename and forget callers.
2. Delete legacy migration planning, commit, rollback, reconciliation and installed-rollout dogfood.
3. Remove migration commands from the extension manifest, VS Code handlers, runtime protocol and engine
   dispatcher; remove Workspace migration methods and startup reconciliation.
4. Make trusted config loading treat every `agents:` row as an exact canonical pointer. Keep
   `terminals:` parsed by the existing operational parser. Remove legacy-agent creation/clone/promote
   routes while retaining canonical Agent Form operations.
5. Remove current docs that advertise migration and update canonical architecture/config examples.
6. Retire installed migration residue only after validating the exact transaction and authority target.

## Key decisions

- **Canonical-only `agents:`** — chosen because the installed legacy fleet is gone; terminals remain
  inline because they are not agent profiles.
- **Preserve historical specs** — chosen because shipped and superseded SDDs are evidence; only current
  product documentation and executable surfaces are changed.
- **Preserve canonical recovery** — chosen because create/edit/rename/forget still need durable
  transactions; only legacy migration journals and rollback are removed.
- **Exact residue cleanup** — chosen because broad deletion could destroy active canonical authority.

## Files touched

- `src/config/agentProfileTransactions.ts` and canonical lifecycle consumers
- `src/config/agentProfileConfigLoader.ts`, `loadConfig.ts`, `YamlConfigEditor.ts`
- `src/workspace/Workspace.ts`, engine/runtime protocol, `src/extension.ts`, `package.json`
- focused unit tests plus current architecture/config documentation

## Risks & unknowns

- Lifecycle, rename and forget reuse lock/file helpers currently defined in the migration module.
- Generic YAML helpers also serve terminals and canonical locator CAS; removing them wholesale would
  break supported behavior.
- Startup recovery shares one root for canonical and migration journals; filtering must remain
  fail-closed after migration entries are removed.

## Visual impact

Removal-only command/config surface. No new rendered UI is introduced.

## Sources consulted

- Task `t-088d08`
- SDD 423, 426, 430 and superseded 439
- `agentProfileMigration.ts`, lifecycle/rename/forget, profile-aware loader and YAML editor
- extension operation protocol/dispatcher and Workspace entry points
