# 431 — Agent profile identity lifecycle — plan

_Drafted from `spec.md` on 2026-07-22._

## Approach

Deliver the contract through three follow-up SDDs rather than one cross-store journal. The first extends the profile lifecycle boundary with stopped-agent persistent rename, shared two-name admission and explicit composition with Evolution. The second owns live tmux/ledger convergence after persistent commit. The third owns destructive retirement and cleanup custody. Each operation shares SDD 430's transaction root and launch blocking but has its own phase table and proof.

`t-152041` stages the destination profile unchanged, prepares one authority compare-and-move, rewrites the exact workspace locator, and defines the irreversible point plus roll-forward table. `t-c3605c` replaces the monolithic live rename with idempotent subsystem steps. `t-980e6e` refuses a live agent, records identity-qualified ownership evidence, retires authorities/locator, neutralizes stale GC, and only then removes or quarantines allowlisted artifacts.

Legacy agents continue through existing Workspace methods. The umbrella itself lands no production code.

## Key decisions

- **Two-name lexical locking** — chosen to prevent opposing renames from deadlocking; rejected one-name locking because destination creation could race.
- **Authority compare-and-move** — chosen to preserve one authority identity and grants; rejected publish-then-retire because it temporarily duplicates authority.
- **Persistent commit before live rename** — chosen so restart recovery has one canonical target; rejected current session-first behavior because rollback crosses tmux and persistent stores.
- **Stopped-only forget** — chosen because destructive cleanup of a live runtime cannot be safely compensated; rejected implicit kill because that broadens user intent.
- **Explicit cleanup allowlist** — chosen to preserve external ownership; rejected reuse of broad legacy `forgetAgent()` because it deletes harness/Pi runtime homes.
- **Receipts, not permanent name bans** — chosen so completed forget permits a fresh identity; rejected indefinite tombstones because they prevent intentional reuse.
- **Three implementation slices** — chosen after probe `probe-58b1346f-3728-4069-9c4d-6a5adf909f96` identified distinct irreversible boundaries; rejected one generalized journal because it would couple profile authority, Evolution, tmux and destructive GC.

## Files touched

- `docs/specs/431-agent-profile-identity-lifecycle/*` — integration contract and decomposition.
- Production/test files are owned by the three follow-up SDDs.

## Risks & unknowns

- Authority move must be exclusive with create/edit/migration on both names.
- Evolution has its own recoverable authority move; ordering it with canonical commit must avoid claiming it as profile authority.
- Existing YAML rename rewrites references beyond one stanza; config CAS must preserve that behavior without allowing generic profile edits.
- Completed forget must not let background GC delete retained runtime homes after the canonical locator disappears.
- Live rename failures after canonical commit must remain retryable without exposing either name to launch.

## Visual impact

None. UI affordances and retained-binding presentation belong to `t-149877`.

## Sources consulted

- SDDs 429 and 430.
- `agentProfileLifecycle.ts`, `agentProfileMigration.ts`, `agentProfileReader.ts` and authority schema.
- `Workspace.renameAgent`, `Workspace.forgetAgent`, `AgentManager.rename` and `agents/forgetAgent.ts`.
- `EvolutionStore.renameAgent` and `EvolutionStore.retireAgent`.
- Headless Workspace, Evolution and lifecycle transaction tests.
