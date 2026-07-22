# 430 — Agent profile lifecycle kernel — plan

_Drafted from `spec.md` on 2026-07-22._

## Approach

Build an `agentProfileLifecycle` domain with pure revision/snapshot/intent validation, then generalize the existing migration transaction coordinator so migration/create/edit/set-enabled share its durable root, per-agent lock, authority CAS and recovery. Reuse the profile reader/schema, authority serialization and affected-stanza CAS primitives. Add internal profile launch metadata through the same loader boundary used for capability projections; strip it before ordinary YAML parsing and reattach only from trusted resolution.

Reconcile lifecycle journals during Workspace activation before migration recovery and profile-aware config load. AgentManager checks trusted `profileLifecycle.enabled` at the common spawn lock, before materialization or tmux creation.

## Key decisions

- **Allowlisted canonical patches** — prevents learned/inherited/projection data and authority grants from being serialized or revoked accidentally.
- **`lifecycle.enabled` default true** — preserves current profiles while giving one canonical disable switch.
- **Whole-input SHA-256 revision** — binds profile, authority and pointer stanza without exposing their contents.
- **Exclusive versioned authority CAS** — all authority writers route through one serialized port; compensation writes only from a known transaction-tagged before/target state.
- **External commit is the proven three-store tuple** — no individual write is authoritative; unresolved durable intent blocks launch until `committed`.
- **Fail-closed degraded state** — chosen because guessing rollback after unrelated edits can overwrite human work.

## Files touched

- `src/config/agentProfileSchema.ts` — profile-only enablement.
- `src/config/agentProfileLifecycle.ts` — snapshot, revision, journal, locking, mutation and recovery.
- `src/config/agentProfileConfigLoader.ts`, `src/config/loadConfig.ts` — trusted internal lifecycle projection.
- `src/config/agentProfileMigration.ts` — generalized coordinator used by migration and lifecycle operations.
- `src/workspace/Workspace.ts` — authority/config ports and activation reconciliation.
- `src/agents/AgentManager.ts` — common pre-spawn disabled guard.
- Focused lifecycle, loader, Workspace and AgentManager tests.

## Risks & unknowns

- SecretStorage cannot join a filesystem atomic rename, so exact readback plus launch blocking and compensation are mandatory.
- Existing migration compatibility must survive journal schema generalization and use the same lock ordering.
- Delivery-bound, resume/restart and restore paths may bypass ordinary spawn-name checks; eligibility must sit at the lowest common allocation boundaries and receive the declared principal.
- Config reload timing must not observe a profile/authority pair while its transaction is active.

## Visual impact

None. This slice provides host/domain state consumed by the later Agent Studio task.

## Sources consulted

- SDDs 423, 426, 428 and 429.
- `agentProfileMigration.ts`, `soulProfileTransactions.ts`, profile reader/resolver/authority/loader.
- Workspace activation and AgentManager spawn paths.
- Probes `probe-a581e95d-7849-4297-96e3-f3e89088eabc` and `probe-5a1ba4d7-1ab9-4c37-8726-47033428854e`.
