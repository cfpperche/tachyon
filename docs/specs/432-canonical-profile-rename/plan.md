# 432 — Canonical profile rename — plan

_Drafted from `spec.md` on 2026-07-22._

## Approach

Add a focused rename transaction beside the create/edit lifecycle domain, sharing its transaction root and launch-block scanner. Acquire old/new profile locks in normalized lexical order, then re-read the source snapshot, destination absence and stopped state. Journal full non-secret authority records, profile digest, source/target locator digests and optional Evolution `profileId` before any mutation.

Move the canonical agent directory atomically to the destination while authority still names the source, verify its full no-follow manifest, then keep the embedded `evolution/` subtree temporarily under the source name. This split is compensable from the same manifest and lets Evolution perform its existing signed owner/authority rename instead of letting the outer transaction rewrite Evolution bytes. Then call one serialized, idempotent profile-authority compare-and-move. That move is the commit point. Rewrite the config from old pointer to the exact new pointer with affected-stanza preconditions, converge Evolution through its authenticated reads and recoverable rename, reload trusted config, and remove the journal.

Startup reconciliation scans rename journals before config load. Pre-commit journals compensate the directory move; post-commit journals only roll forward. Unknown profile, authority, config or Evolution states become degraded. The generic profile transaction blocker scans lifecycle and rename journals so both names are denied by launch and create/reuse paths.

Workspace routes only stopped profile-backed agents into this service. Legacy rename keeps its existing manager/config/Evolution sequence; running profile-backed rename reports that live convergence belongs to the next slice.

## Key decisions

- **Authority move is the commit point** — chosen because SecretStorage can atomically rewrite its whole registry and uniquely establishes the destination identity; rejected config-first because locator presence cannot prove authority ownership.
- **Move the entire profile home, compose Evolution through its own authority** — chosen to preserve unknown identity-owned bytes while letting the embedded Evolution subtree rewrite its name-bearing signed bytes through its existing protocol.
- **Exact pair-state replay** — chosen so acknowledgement loss is distinguishable from collision; rejected revision-only checks because records may share a revision while differing in grants or identity.
- **Evolution after commit, roll-forward only** — chosen because its authority is independently recoverable; rejected trying to roll it back jointly with profile authority.
- **Stopped source in this slice** — chosen to keep tmux/ledger convergence out of the persistent identity commit; rejected calling legacy `manager.rename()` after commit because it is not replayable as one step.

## Files touched

- `src/config/agentProfileMigration.ts` — ordered multi-name lock and idempotent authority move contract.
- `src/config/agentProfileLifecycle.ts` — shared transaction blocking across operation subdirectories.
- `src/config/agentProfileRename.ts` — rename journal, commit, compensation and recovery.
- `src/config/YamlConfigEditor.ts` — exact profile-pointer rename helper if the generic writer is too broad.
- `src/workspace/Workspace.ts` — authority move port, startup reconciliation and profile-aware routing.
- Focused rename and Workspace compatibility tests.

## Risks & unknowns

- Evolution rename is independently journaled; the outer journal acknowledges only a destination profile whose full authority validation succeeds and whose `profileId` matches the recorded source.
- Config may receive unrelated edits after intent; affected-source and destination-absence checks must preserve them.
- Directory rename requires no-follow custody for both parent and destination absence.
- Malformed rename journals fail closed at profile admission; v1 favors custody over partial availability because this is one local workspace, not a multi-tenant service.

## Visual impact

None. UI behavior belongs to the later Agent Studio slice.

## Sources consulted

- SDDs 430 and 431.
- `agentProfileLifecycle.ts`, `agentProfileMigration.ts`, `agentProfileReader.ts`, `agentProfileAuthority.ts`.
- `Workspace.renameAgent`, `AgentManager.rename`, `YamlConfigEditor.renameAgent`.
- `EvolutionStore.renameAgent` and its recovery tests.
- Architecture probe `probe-58b1346f-3728-4069-9c4d-6a5adf909f96`.
