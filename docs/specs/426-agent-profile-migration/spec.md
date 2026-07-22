# 426 — Agent profile migration

_Created 2026-07-22._

**Status:** shipped

**Closure:** Shipped 2026-07-22 — trusted profile loading, lossless offline migration, durable
reconciliation/rollback, command-palette operations, operator documentation and isolated dogfood are
complete. Focused, invariant, typecheck and full verification gates pass.

## Intent

Tachyon now has a canonical `agent.yml` schema and a strict resolver, but workspace configuration still
requires every agent to be defined inline in `tachyon.yml`. This slice introduces the first usable
cutover: one agent stanza may be either a legacy inline definition or one compact pointer to the
conventional canonical profile. It also provides an explicit, recoverable migration for eligible
legacy agents without silently changing their effective runtime behavior.

The compact form is exact and intentionally boring:

```yaml
agents:
  codex:
    profile: .tachyon/agents/codex/agent.yml
```

The pointer is a locator, not authority. The profile is consumable only when its bytes match a
host-custodied profile head and a registered runtime inspector supplies an exhaustive attestation.
Inline fields and `profile` can never coexist in one stanza. A workspace may contain different agents
in legacy and profile modes during rollout.

Affected Product Invariants: **PI-001 — promise and fixed oracle unchanged.** Project Guidance remains
project-owned in `settings.projectGuidance`; migration may record explicit inheritance/provenance but
must neither move nor rewrite its bytes or alter configured/unconfigured behavior.

## Source and loading contract

- Syntax parsing remains synchronous and side-effect free. It returns a discriminated
  `legacy | profile` declaration rather than hiding filesystem or authority access inside YAML parsing.
- The profile path must equal `.tachyon/agents/<exact-agent-name>/agent.yml`; arbitrary paths,
  traversal, aliases and case-folded substitutions are rejected.
- A second resolution phase receives a frozen host authority snapshot and a registered native-input
  inspector. Only after the existing resolver succeeds may a profile be projected to `ManagedEntryDef`.
- The runtime projector is adapter-owned and must prove that generated argv/environment/private-home
  behavior suppresses every native input reported by the inspector. Missing adapters or partial
  attestations fail closed.
- Legacy stanzas retain their current parser, defaults and runtime behavior unchanged.
- Terminals remain inline in this slice.
- Plugins are never read, moved, filtered, copied or represented by profile migration.

## Migration eligibility

Migration is explicit and starts with a dry run. The V1 migration registry lists every supported
legacy field and the adapter that can prove before/after equivalence. Any unclassified key, YAML merge,
alias, duplicate key, unsupported runtime construct or field owned by a later umbrella slice blocks
commit and reports its exact path and owner.

This slice may migrate:

- a literal runtime command that the registered adapter can parse and project without shell ambiguity;
- `cwd`, lifecycle fields, role, worktree policy, isolation and ownership when the canonical schema and
  projector preserve their normalized behavior;
- environment entries only when the operator explicitly classifies every item as a non-secret value or
  supplies a typed secret reference—names never classify secrets automatically;
- setup/verification only through caller-supplied pinned reference bindings;
- project/workspace defaults only by explicit named inheritance recorded in the profile.

This slice refuses and leaves the whole agent legacy when it encounters `instructions`, `soul`,
`selfEvolution`, `harness` capabilities or another field owned by `t-a2827d`/`t-a34bb7`, until those
slices extend the migration registry. Refusal writes nothing. It is not a partial migration.

Before commit, the service compares the normalized legacy `ManagedEntryDef` with the candidate
profile projection, including defaults, cwd semantics, project inheritance and adapter output. Any
behavioral difference outside representation, immutable `agentId` and provenance blocks migration.

## Transaction and authority contract

Migration requires the agent to be stopped and serializes one principal at a time. It uses a durable
host-owned intent under `.tachyon/agent-profile-migrations/` plus a host-custodied authority port.
Workspace paths cannot declare completion.

The recoverable state machine is:

1. capture the exact `tachyon.yml` file identity, affected-stanza CAS and full input digest;
2. validate/profile-project the exact candidate in an isolated preflight root using the prospective
   authority snapshot and exhaustive adapter attestation;
3. durably write the journal, original config backup and staged profile; fsync files/directories;
4. publish `agent.yml` without following symlinks, then establish the host profile head;
5. CAS-replace only the affected YAML stanza with the compact pointer and fsync `tachyon.yml` last;
6. reload through the same trusted profile loading seam and commit the journal only after equivalence;
7. on failure or startup reconciliation, finish the exact intended state or compensate with digest/CAS
   checks. Never overwrite post-migration human edits.

Exact completed state is idempotent success. An existing equivalent profile may be adopted only when
the journal proves this transaction created it and authority matches. Divergent profile, pointer,
legacy stanza, authority or backup state produces a three-way conflict and blocks launch; it is never
normalized or overwritten automatically.

Rollback restores the original stanza only when its post-migration CAS still matches, retires the
matching host profile head and removes only profile bytes created by that transaction when their digest
is unchanged. Otherwise the transaction becomes visibly degraded for manual repair.

## YAML, reload and LKG

- The rewrite uses the YAML concrete syntax tree/source ranges and changes only the selected agent
  stanza. Every byte outside that range must remain identical; comments, order, scalar styles and all
  workspace/plugin configuration are preserved.
- Duplicate keys, aliases, anchors/merge constructs affecting the stanza, or ambiguous ranges are
  rejected rather than reserialized.
- Migration preflights the exact post-write pair before commit. Reload never activates a partial or
  unattested profile.
- Warm reload failure retains the prior in-memory config and records a visible config failure, as today.
  Cold start remains fail closed.
- LKG remains render-only and gains source mode, `agentId`, profile/effective digest and authority
  revision for profile-backed rows. It never authorizes spawn or extends stale authority.
- A changed/missing profile head invalidates the profile-backed row even when an older LKG exists.

## Operator surface

`Tachyon: Migrate Agent Profile` is an offline command: choose one stopped legacy agent, inspect the dry
run and blockers, then explicitly confirm commit. `Tachyon: Roll Back Agent Profile Migration` lists
only safely reversible committed migrations and shows conflicts without overwriting them. Agent Studio
editing and general lifecycle operations remain owned by `t-e50d4f`.

## Acceptance criteria

- [x] **Scenario: mixed rollout loads safely**
  - **Given** a workspace with legacy agents and one exact profile pointer
  - **When** configuration reloads with valid host authority and adapter attestation
  - **Then** all entries produce equivalent `ManagedEntryDef` values and retain explicit source mode
- [x] **Scenario: split authority fails closed**
  - **Given** one stanza contains `profile` plus any inline field, or canonical bytes exist against an inline owner
  - **When** initial load or reload runs
  - **Then** the agent is not activated and diagnostics name both owners without choosing precedence
- [x] **Scenario: migration is lossless and local**
  - **Given** an eligible stopped legacy agent and unrelated comments/settings/agents
  - **When** dry run and confirmed migration complete
  - **Then** only that stanza becomes the exact pointer, outside bytes are unchanged, and effective behavior is equivalent
- [x] **Scenario: unsupported data remains legacy**
  - **Given** an unknown/deferred field, ambiguous YAML construct, unclassified environment value or unsupported adapter
  - **When** migration is requested
  - **Then** exact blockers are returned and no workspace, authority or profile bytes change
- [x] **Scenario: crash recovery is deterministic**
  - **Given** interruption after any journal phase
  - **When** startup reconciliation runs
  - **Then** it finishes the exact intended state or restores the exact prior state; divergence becomes degraded without overwrite
- [x] **Scenario: rollback respects later edits**
  - **Given** a completed migration whose profile or pointer was edited later
  - **When** rollback is requested
  - **Then** CAS refuses destructive rollback and reports a three-way conflict
- [x] **Scenario: invalid profile does not borrow LKG authority**
  - **Given** a valid profile-backed load followed by changed profile/head/attestation
  - **When** reload or cold start runs
  - **Then** prior live state may remain visible, but new spawn is refused and LKG never authorizes stale bytes
- [x] PI-001 remains green with unchanged oracle and unchanged project-owned guidance bytes/order.
- [x] Profile migration never reads or writes plugin payloads, locks, assignment, consent or scope.
- [x] The command surface provides dry-run, explicit confirmation, commit, rollback and actionable conflicts.

## Non-goals

- Migrating Soul, persistent instructions, Evolution, selected memory or non-plugin capabilities before
  their owning slices extend the registry.
- Agent Studio create/edit/import/export/rename/clone/forget integration.
- Supporting terminals or every runtime adapter in the first migration registry.
- Removing legacy inline compatibility.
- Changing workspace-wide plugin behavior or designing agent-scoped plugins.

## Open questions

None at the contract level. Adapter support is additive: an adapter is eligible only after its inspector,
projector and equivalence tests satisfy this spec.
