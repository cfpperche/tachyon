# 426 — Agent profile migration — plan

_Created 2026-07-22._

## Approach

1. Split `tachyon.yml` parsing into synchronous source declarations and trusted resolution. Preserve
   the current legacy parser as one branch; add an exact profile-pointer branch with no merge path.
2. Add an adapter registry whose inspector/projector pair converts a resolved profile to
   `ManagedEntryDef` and proves native-input suppression. Start with the smallest measured adapter;
   unsupported runtimes remain legacy.
3. Add a host-custodied profile authority store backed by the existing SecretStorage boundary. Cache
   immutable snapshots before config reload; never derive authority from workspace files.
4. Extend `Workspace.reloadConfig` to resolve profile pointers through the frozen authority/inspector
   seam before replacing live config. Preserve current warm-LKG behavior and enrich profile-backed rows.
5. Build a strict migration planner: exact supported-field registry, explicit environment/reference
   decisions, source-range YAML replacement and normalized before/after equivalence proof.
6. Build journaled commit/reconcile/rollback around same-filesystem staging, durable writes, CAS and
   authority transitions. Block migration of live agents.
7. Expose two narrow command-palette operations for dry-run/commit and safe rollback; do not modify
   Agent Studio.
8. Verify focused config, migration, authority, reload/LKG and PI-001 tests; dogfood the command on an
   isolated fixture workspace, not Tachyon's live self-hosting fleet.

## Key decisions

- **Exact string pointer, not a free path or boolean** — the YAML remains self-describing while the
  conventional locator and path-custody boundary stay fixed.
- **Discriminated source union before resolution** — keeps synchronous YAML syntax separate from host
  secrets, filesystem reads and adapter inspection.
- **No dormant write path** — migration commit is unavailable until the shipped reload path can consume
  the exact result; dry-run alone may execute earlier during implementation.
- **Registry-based eligibility** — every legacy key is migrated, deferred with its owning task, or
  rejected. There is no best-effort field dropping.
- **Measured adapter support** — supporting fewer runtimes safely is preferable to an attestation that
  merely asserts exhaustiveness. New adapters extend the registry later.
- **Source-range patch** — rejects YAML constructs that cannot prove bytes outside the stanza unchanged;
  does not reserialize the document.
- **Journal + external authority** — multi-file atomicity is impossible; recoverability and CAS define
  correctness instead.
- **No plugin dependency** — settings and all unrelated bytes are preserved exactly, so migration cannot
  change plugin scope indirectly.

## Files expected

| Path | Purpose |
|---|---|
| `src/config/agentProfilePointer.ts` | Strict inline/profile declaration parser and exact pointer validation |
| `src/config/agentProfileProjection.ts` | Registered native inspector/projector and equivalence model |
| `src/config/agentProfileAuthority.ts` | Host-custodied profile snapshot schema/port/serialization |
| `src/config/agentProfileMigration.ts` | Dry-run planner, journal, commit, reconciliation and rollback |
| `src/config/loadConfig.ts` | Two-phase source parsing and resolved config composition |
| `src/config/configLkg.ts` / `configFailure.ts` | Profile provenance and stale-authority-safe degraded behavior |
| `src/config/YamlConfigEditor.ts` | Proven source-range pointer replacement/CAS helpers |
| `src/workspace/Workspace.ts` | Authority cache, profile-aware reload and migration methods |
| `src/extension.ts`, `package.json`, `package.nls*.json` | Narrow command-palette surface |
| `src/config/tachyon.schema.json` | Inline-or-profile discriminated schema |
| `docs/architecture/agent-profiles.md` | Pointer format, eligibility, safety and rollback documentation |
| `test/unit/agentProfileMigration.test.ts` | Transaction, custody, equivalence, crash and rollback coverage |
| existing config/workspace tests | Parser, reload, LKG and compatibility coverage |

## Risks

- Refactoring `parseConfig` touches many consumers; preserve a resolved `TachyonConfig` surface and keep
  source declarations internal to the loader.
- SecretStorage is async while reload is currently sync; authority snapshots must be loaded/reconciled
  before synchronous activation or reload must become an explicit serialized async transaction.
- YAML ranges can be invalidated by concurrent edits; bind file identity/digest and reparse immediately
  before CAS write.
- Adapter inspection can miss a native source. Treat unknown files/keys and unsupported runtime versions
  as unverifiable, never as an empty observation set.
- Rollback after human edits must degrade instead of restoring backups over newer intent.

## Sources consulted

- SDD 423 canonical ownership, identity, authority, migration and plugin boundaries.
- SDD 425 resolver authority/attestation/path-custody contract and implementation.
- `src/config/loadConfig.ts`, `YamlConfigEditor.ts`, `configLkg.ts`, `configFailure.ts`.
- `src/workspace/Workspace.ts` reload, SecretStorage authority heads and config mutation paths.
- `src/agents/soulProfileTransactions.ts` durable journal/CAS/compensation precedent.
- `src/harness/HarnessManager.ts`, `src/runtime/launchPreflight.ts`, `src/agents/AgentManager.ts`.
- Probe `probe-44cae0a6-9037-4c2d-a7f3-a87eb85e0df2` adversarial boundary review.
