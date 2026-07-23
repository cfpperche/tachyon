# 426 — agent-profile-migration — notes

_Created 2026-07-22._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## 2026-07-22 — boundary review

Probe `probe-44cae0a6-9037-4c2d-a7f3-a87eb85e0df2` rejected both a dormant migrator that could
write unreadable pointers and a broad loader that bypassed host authority/native attestation. The
accepted boundary is a narrow end-to-end vertical slice: strict source union, trusted read-only
resolution, measured adapter, offline migration command, exact preflight and recoverable rollback.
Unsupported fields remain wholly legacy. Full probe evidence is retained at
`.tachyon/probes/probe-44cae0a6-9037-4c2d-a7f3-a87eb85e0df2/result.json`.

## 2026-07-22 — first trusted loading slice

The first adapter is intentionally narrower than the eventual migrator: it accepts only literal
`codex`, no runtime selectors, and requires every known Codex native config source to be absent or
whitespace-only. Inspection walks from retained directory descriptors and opens every component
without following symbolic links. A non-empty real user config therefore keeps that agent legacy;
support expands only with another measured inspector/projector revision.

`parseConfig` remains the side-effect-free legacy parser. `parseProfileAwareConfigSyntax` substitutes
only a non-authoritative placeholder for constructor-time workspace settings, while
`loadProfileAwareConfig` owns profile bytes, SecretStorage authority and native attestation. The
Workspace caches authority before its first trusted reload. A failed warm reload retains the old row
for visibility but explicitly blocks new starts of every previously profile-backed row. The LKG stores
profile identity/digests for rendering only.

The implementation uses a separate SecretStorage registry from Delivery authority heads. Corruption
in profile custody fails profile-backed agents closed without disabling Bridge caller identity or
Delivery authority. Migration-time authority mutation/reconciliation remains in `t-1d1842`.

## 2026-07-22 — transactional migration slice

The first migration registry is deliberately strict: exact literal `codex`; lifecycle, cwd, role,
worktree/isolation/ownership; and environment values only when every key is explicitly acknowledged as
non-secret. Runtime arguments, Soul, persistent instructions, Evolution, harness/capabilities,
worktree setup and verification refuse the whole migration. The planner materializes the candidate in
an isolated preflight root and requires deep equality with the normalized legacy `ManagedEntryDef`.

The YAML editor now captures the exact source range and digest of one plain stanza value. It rejects
anchors, aliases and merge keys, then replaces only that range. Commit and rollback re-read the latest
file and CAS only that range, so unrelated edits made before commit or after migration survive.

Transactions live under `.tachyon/agent-profile-migrations/<txid>` with durable journal, original
stanza backup and staged profile. A per-principal durable lock serializes concurrent attempts. Profile
publication/removal is descriptor-relative and no-follow; host authority uses SecretStorage CAS and
readback; `tachyon.yml` is written last after the exact prospective trusted reload passes. Startup
reconciliation commits a complete target tuple, compensates a partial tuple, and marks divergence
degraded. Committed journals remain as the rollback authority; rollback refuses any later change to
the pointer stanza, profile bytes or host authority.

## 2026-07-22 — operator surface and documentation

Two native VS Code commands expose the transaction without adding a custom UI: `Tachyon: Migrate
Agent Profile` lists stopped agents, reports dry-run blockers, requires explicit classification of
non-secret environment values and asks for modal commit confirmation; `Tachyon: Roll Back Agent
Profile Migration` lists committed rollback journals and requires modal confirmation. The service
rechecks stopped state and every CAS invariant at commit/rollback time, so a stale picker result cannot
bypass the transaction boundary.

The architecture guide records the ownership boundary between workspace configuration, canonical
agent profile, host-custodied authority and runtime-native inputs. The cookbook gives operators a
preview/migrate/verify/rollback path and calls out deferred lanes, especially plugins. No plugin path,
payload, assignment, lock, consent or scope participates in this implementation.

Focused i18n/protocol tests passed, the isolated migration + rollback dogfood passed, PI-001 invariants
passed, typecheck passed, and `verify:full:quiet` completed with 471 files passing and 5,359 tests
passing (3 skipped).

## Verification log

### 2026-07-22T16:57:07Z — fail (3/4) — source: tasks.md
- `npm test -- test/unit/agentProfileMigration.test.ts test/unit/config.test.ts test/unit/yamlEditor.test.ts test/unit/configFailure.test.ts test/unit/workspaceHeadless.test.ts` — pass
- `npm run test:invariants` — pass
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — fail

### 2026-07-22T17:02:06Z — pass (4/4) — source: tasks.md
- `npm test -- test/unit/agentProfileMigration.test.ts test/unit/config.test.ts test/unit/yamlEditor.test.ts test/unit/configFailure.test.ts test/unit/workspaceHeadless.test.ts` — pass
- `npm run test:invariants` — pass
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — pass

## Dogfood log

### 2026-07-22T17:03:15Z — pass (1/1) — source: tasks.md — commit: 225ad1375425ddc88d6acc4d8db029530f3e4820
- `npx vitest run test/unit/agentProfileMigration.test.ts -t "dogfood: commits and rolls back an isolated profile fixture"` — pass
