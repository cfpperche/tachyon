# 436 — canonical-profile-forget — plan

_Drafted from `spec.md` on 2026-07-22. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add a dedicated `agentProfileForget` transaction beside lifecycle and rename. Its journal captures the immutable authority record, exact source and target config digests/text, the canonical-home manifest, optional Evolution `profileId`, and retained-binding diagnostics. The existing normalized profile lock serializes it with create/edit/migrate/rename.

Writing `intent` installs the admission barrier. Forget rechecks manager/tmux state under that barrier; a live or indeterminate binding removes the pre-commit intent and refuses. Writing `committing` is the irreversible decision: startup recovery always rolls forward from there. Roll-forward retires Evolution authority, retires the exact profile authority record, installs the exact locator-free config through CAS, quarantines the manifest-matching home under `.tachyon/retired-agent-profiles/<agentId>/<txid>`, activates trusted config, and records `committed` without scheduling later cleanup.

Workspace routes only profile-backed deletion through this transaction before the legacy YAML mutation/footprint remover. Canonical forget deliberately does not call the broad name-based `forgetAgent` helper. Spawn admission and startup reconciliation scan unresolved forget journals; committed receipts are inert.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **The journaled `committing` transition is the single commit decision** — chosen because separate SecretStorage, filesystem, and config writes cannot be atomic; recovery can still make one deterministic direction choice.
- **Quarantine the complete canonical home** — chosen because it preserves current Evolution and future profile-local plugin data while proving custody with a captured manifest; recursive deletion would lose recoverability.
- **Retain runtime homes and ambiguous bindings** — chosen because they are runtime/private state without `agentId` ownership evidence; name-based deletion is unsafe after reuse.
- **Keep committed receipts inert** — chosen so audit survives while stale recovery cannot affect a fresh same-named identity.

## Files touched

- `src/config/agentProfileForget.ts` — journal, admission query, commit/recovery state machine, custody checks, and quarantine.
- `src/workspace/Workspace.ts` — startup reconciliation, spawn blocking, and canonical delete routing.
- `src/engine-service/extensionOperationService.ts` — invoke canonical forget before any legacy mutation.
- `test/unit/agentProfileForget.test.ts` — crash matrix, custody, admission, and reuse.
- `test/unit/workspaceHeadless.test.ts` — end-to-end routing and preservation boundary.

## Risks & unknowns

- SecretStorage retirement can lose its response; every authority step must recognize the exact already-retired state without accepting a replacement record.
- Config reload between locator removal and home quarantine must remain fail-closed until the transaction commits.
- Existing startup GC is name-scoped; canonical forget must quarantine or retain its owned artifacts synchronously and leave no deferred cleanup callback.

## Visual impact

None; the existing Remove action and confirmation remain the operator surface.

## Sources consulted

- SDD 431 identity lifecycle decomposition; SDD 432 canonical rename; SDD 433 live convergence.
- Architecture review `probe-58b1346f-3728-4069-9c4d-6a5adf909f96`.
- Existing profile authority, Evolution retirement, Workspace delete, and legacy `forgetAgent` implementations.
