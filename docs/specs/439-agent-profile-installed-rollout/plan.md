# 439 — agent-profile-installed-rollout — plan

_Drafted from `spec.md` on 2026-07-23. The approach, not the steps (those go in `tasks.md`)._

## Approach

Deliver the rollout as one coordinating SDD with six named implementation Tasks:

1. `t-7e7464` closes Claude/Grok runtime-native inventories and measured adapters. `grok-x` must prove
   external-cwd/trust semantics against the Grok adapter.
2. `t-1f35d4` binds the Evolution selector to the existing host-owned approval/head authority; it is
   not part of ordinary profile mutation.
3. `t-be11d9` extends canonical authored mutation and Agent Studio using the field ownership matrix.
4. `t-2d4d87` extends the existing single-agent planner/journal/reconcile/rollback transaction for all
   five installed definitions.
5. `t-673096` runs mirror proof, then five sequential installed transactions. Before each migration it
   proves the target stopped and unoccupied; after each it verifies profile/authority/pointer tuple,
   reload and fresh launch. A durable checkpoint records completed agents and the next target. On
   interruption, startup reconciles only the in-flight single-agent journal, revalidates completed
   tuples, and resumes—there is no claim of fleet atomicity.
6. `t-088d08` removes legacy production writers/callers only after installed proof, retaining an
   enumerated read/recovery fixture allowlist and a guard against new inline writers.

Installed dogfood exercises fresh start, reload, resume/fork, lifecycle actions, import/export,
projection tampering, LKG/config failure, authority/path adversaries and plugin non-interference.
After installed evidence and legacy retirement are green, close umbrellas 429 and `t-7d2cc0`.

## Key decisions

- **Support the installed fleet, not every catalog CLI** — chosen because Claude, Codex and Grok are the
  runtimes actually in production; rejected pretending all Quick Add binaries are canonically supported.
- **One adapter per measured runtime contract** — chosen because native prompt/config precedence differs;
  rejected a generic exhaustive authority that cannot prove runtime-specific inputs.
- **Canonical Studio fields follow schema ownership** — chosen because users need one complete form for
  authored configuration; rejected continuing a hidden legacy form or hand-editing `agent.yml`.
- **Evolution/Soul/memory stay separate protocols** — chosen because their authority and approval rules
  differ from ordinary profile CAS; rejected flattening their bytes into a generic form patch.
- **Migrate the installed workspace only after mirror dogfood** — chosen because representation cutover
  is recoverable but affects live agents; rejected using the production fleet as the first fixture.
- **Remove legacy after proof** — chosen by the single-user/single-workspace product context; rejected a
  speculative deprecation window, telemetry and compatibility bureaucracy.
- **Five recoverable transactions, not one fleet transaction** — chosen because the existing journal is
  already single-agent and each successful cutover can stand independently; rejected adding a fleet
  atomicity protocol for one installed workspace.

## Files touched

- `src/config/agentProfileProjection.ts` — runtime inspector/projector registry and measured adapters.
- `src/config/agentProfileMigration.ts` — eligibility and equivalence for installed agents.
- `src/config/agentProfileLifecycle.ts` / Studio domain — closed authored mutation fields and CAS.
- `src/webview/agent-studio-shell/*` / `AgentStudioAdapter.ts` — complete canonical form.
- `src/workspace/Workspace.ts` / `HarnessManager.ts` — launch/materialization and installed migration.
- `src/config/loadConfig.ts`, schema and YAML writer paths — retire obsolete inline operations.
- Focused config, projection, migration, Studio, workspace and Dev Host scenarios.
- `tachyon.yml` and `.tachyon/agents/*` — final installed cutover.

## Risks & unknowns

- Claude and Grok may consume forming native files/flags not yet inventoried; support must fail closed
  until the inventory is exhaustive.
- Existing real auth/runtime state must remain outside profile export and survive private-home rebuild.
- Agent Studio's broad legacy `FormState` cannot simply become writable canonical state; each field needs
  an explicit owned schema mapping.
- Migrating the live `codex` row while this agent is running is forbidden; cutover needs a bounded
  stopped-agent handoff.
- Removing legacy parsing too early can strand recovery fixtures; cleanup follows installed proof.

## Legacy retirement allowlist

Before `t-088d08` deletes code, it must enumerate exact retained read/recovery entry points. Production
Agent Studio, Quick Add, migration completion, rename/clone/import and config mutation must have no
inline writer. A module-boundary test fails on any new production import of the legacy writer. Legacy
parsing may remain only for explicit pre-migration fixtures or rollback/recovery inputs named in that
allowlist; it cannot activate a new production inline agent.

## Visual impact

New Agent and canonical Edit regain the authored operational sections currently hidden. Capture dark,
light and high-contrast screenshots plus installed keyboard/save/reload dogfood. Verify that fields
appear only when supported and that ownership/read-only states remain understandable.

## Sources consulted

- SDD 423 canonical ownership/trust boundaries.
- SDD 426 migration transaction, rollback and LKG.
- SDD 429 lifecycle/Studio integration contract.
- SDD 438 narrow canonical Studio write boundary and installed evidence.
- `src/config/agentProfileProjection.ts`, `agentProfileMigration.ts`, `agentProfileLifecycle.ts`.
- `src/webview/AgentStudioAdapter.ts`, `agent-studio-shell/domain.ts`, `App.tsx`.
- Current `tachyon.yml` and `.tachyon/agents/codex/evolution/`.
