# 425 — Agent profile resolver

_Created 2026-07-22._

**Status:** shipped

**Closure:** Task `t-17a2c2` delivered the standalone V1 schema, descriptor-rooted reader,
authority/attestation-bound resolver and focused adversarial coverage. Runtime wiring and YAML
migration remain in `t-4f82e0`; no runtime projection or plugin behavior changed in this slice.

**Verify:** `npm test -- test/unit/agentProfileResolver.test.ts`
**Verify:** `npm run test:invariants`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
**Dogfood:** `npm test -- test/unit/agentProfileResolver.test.ts`

## Intent

SDD 423 established `.tachyon/agents/<agent>/agent.yml` as the canonical definition of a persistent
agent, but Tachyon still has no safe loader or stable in-memory representation for that definition.
Without this boundary, later migration code would have to mix file access, legacy compatibility,
precedence, trust checks and runtime-specific materialization in one operation.

This slice introduces a side-effect-free resolver that reads one canonical profile, validates its
identity and references, and produces one deterministic, secret-unresolved normalized result with
field-level provenance. “Secret-unresolved” means the resolver never opens a secret store, adopts an
ambient credential or copies opaque legacy command/environment values. Human-declared
`environment.values` remain ordinary profile data; the resolver does not pretend heuristics can prove
whether a human mislabeled arbitrary text. A legacy `tachyon.yml` agent stanza remains a supported
alternative input
while no canonical profile exists. The two sources can never jointly own an agent. Runtime adapters
may consume the normalized result in later slices, but this slice does not write their private homes.

Affected Product Invariants: **PI-001 — the project-guidance ownership promise and fixed oracle remain
unchanged.** The resolver may record an explicitly enabled project-owned guidance dependency, but it
must not discover guidance implicitly, copy it into the profile, reorder it or remove its source
provenance. Run `npm run test:invariants` in addition to the normal gates.

## Resolver boundary

The internal resolver accepts the workspace root, agent name, the host-custodied profile-head snapshot,
a complete runtime-adapter inspection attestation, and optionally the already-validated legacy agent
definition and workspace-owned inherited settings. It resolves only the conventional profile path
`.tachyon/agents/<agent>/agent.yml`; choosing or migrating a profile pointer in `tachyon.yml` belongs
to `t-4f82e0`. Workspace path presence alone is never profile authority.

The result is a versioned `ResolvedAgentProfile` value containing:

- canonical `agentId` when profile-backed, agent display/name metadata and resolution mode;
- normalized semantic field families for runtime selectors, environment, prompt/identity selectors,
  lifecycle, workspace/isolation, ownership, verification and non-plugin capability references;
- one source record for every present effective leaf, including source kind, path/field, profile or
  project digest where applicable and pinned/floating reference mode;
- a stable digest over the resolved semantic value and reference identities;
- the host profile authority revision and runtime-inspector identity/version/digest that authorize the
  source and prove native-input coverage;
- warnings that do not affect authority, and structured errors that prevent consumption.

The resolver never returns resolved secret values. Typed secret references remain opaque identifiers,
and diagnostics redact identifiers whose text itself is sensitive.

Determinism is defined for identical declared inputs. Unordered maps, reference inventories,
provenance and diagnostics use fixed code-unit order rather than host locale. Arrays whose order is
part of behavior or provenance—project-guidance sources, watch/setup sequences and explicitly ordered
assignments—retain declared order, and that order is included in the effective digest.

## V1 source and precedence rules

| Input | V1 treatment |
|---|---|
| Canonical `agent.yml` | Sole agent-scoped owner when present and valid |
| Legacy `tachyon.yml` stanza | Compatibility owner only when the host profile head declares canonical state absent |
| Both canonical and legacy | Hard conflict; no merge and no winner |
| Command/model/provider selectors | Canonical typed selectors win only after conflicting native flags/config are absent or explicitly suppressed by the caller's adapter evidence |
| Non-secret environment | Explicit profile value, then only named inherited values requested by the profile |
| Secret environment | Opaque typed reference only; value resolution is after this slice |
| Private runtime config/home | Projection or observed conflict, never a configuration source |
| Project guidance | Project-owned bytes; profile may explicitly inherit/reference them, with source order and digest preserved |
| Global/workspace defaults | Applied only for field names explicitly requested by the profile |
| Plugins | Not inspected, represented, filtered or changed |

The resolver requires an exhaustive native-input attestation from a named/versioned inspector, bound
to its executable digest, the host profile authority revision and the digest of the effective runtime
selectors. An observed model, provider, prompt, environment or capability input that could override
the resolved declaration is a conflict unless the observation proves suppression or isolation before
launch. Missing, partial, stale or cross-adapter attestations fail closed. This keeps private
`config.toml`, command flags and ambient environment from becoming silent higher-priority owners.

Legacy command and environment values remain private inputs owned by the existing launch path. The
normalized compatibility result carries only the command digest and environment variable names; it never
copies opaque legacy values that may contain credentials. Canonical `runtime` has typed selectors and
no free-form argv lane; `runtime.executable` is one token/path, not a command line. Worktree setup and
verification are pinned references rather than inline commands. Explicit `environment.values` is the
human-declared non-secret channel; credentials use typed `environment.secrets` references. Intentional
misclassification is rejected by governed profile editing policy, not guessed from variable names.

## Path and byte custody

- Agent names are validated before path construction; profile and agent-local reference paths must be
  relative, normalized and contained by the canonical workspace/profile root.
- The canonical workspace is opened once and every profile path component is traversed relative to
  retained directory descriptors with no-follow/directory flags. The exact profile directory
  descriptor remains open while references are consumed; pathname replacement cannot redirect them.
- The profile, each traversed profile directory and each consumed reference must be a regular
  non-symlink path of the expected kind. Special files and escaping/replaced ancestors are rejected.
- If the host cannot provide verified descriptor-relative traversal and no-follow/nonblocking flags,
  canonical resolution is unsupported and fails closed rather than falling back to pathname checks.
- Reads bind the opened descriptor identity to the validated path, enforce bounded sizes and hash the
  exact consumed bytes. Pinned references must match their declared digest.
- A file changed between validation and consumption fails resolution. A later edit produces a new
  result/digest on the next call; there is no hidden cache or stale last-known-good fallback here.
- Validated local reference contents are discarded after hashing. The normalized result contains only
  identity, digest and provenance; later materialization must reopen and revalidate the same digest.
- Floating project guidance is resolved only from the project-owned bundle supplied by the caller and
  records the exact ordered sources and digests selected for this resolution.

## Acceptance criteria

- [x] **Scenario: canonical profile resolves deterministically**
  - **Given** a valid schema-version-1 `agent.yml`, matching host profile head, exhaustive adapter attestation and unchanged referenced bytes
  - **When** the resolver is called repeatedly with identical explicit inputs
  - **Then** it returns deeply equal semantic values, provenance and digests without writing files
- [x] **Scenario: legacy compatibility is an alternative owner**
  - **Given** no canonical profile and one validated legacy agent definition
  - **When** the resolver runs
  - **Then** it returns a normalized legacy-mode result whose public leaves identify `tachyon.yml`
    provenance, while raw command/environment values remain outside the result
- [x] **Scenario: double authority fails closed**
  - **Given** both a canonical profile and a legacy stanza for the same agent
  - **When** the resolver runs
  - **Then** resolution fails with both source locations named and no effective profile
- [x] **Scenario: missing or malformed profile is explicit**
  - **Given** neither source, an unsupported schema version, invalid identity, unknown key or invalid field shape
  - **When** the resolver runs
  - **Then** it returns a stable structured diagnostic and no partial effective value
- [x] **Scenario: runtime-native override cannot outrank the profile**
  - **Given** a typed profile model/provider and an observed command flag, environment selector or private-home value that can override it
  - **When** the adapter does not prove suppression/isolation
  - **Then** resolution fails and diagnostics contain source names but no secret values
- [x] **Scenario: authority and native-input proofs are mandatory**
  - **Given** a missing/stale host profile head or a missing/partial/cross-adapter runtime attestation
  - **When** the resolver runs
  - **Then** it fails without returning a consumable value
- [x] **Scenario: inheritance is explicit per field**
  - **Given** workspace/global defaults and ambient variables that the profile did not name
  - **When** the resolver runs
  - **Then** those values are absent; named inherited values carry their original owner provenance
- [x] **Scenario: unsafe or changed reference is rejected**
  - **Given** a symlink, special file, escaping path, digest mismatch or file changed during a bound read
  - **When** the resolver consumes that reference
  - **Then** it fails without returning bytes from the unsafe or stale source
- [x] **Scenario: ancestor replacement cannot redirect a reference**
  - **Given** the profile directory pathname is renamed or replaced after `agent.yml` is opened
  - **When** a declared local reference is consumed
  - **Then** resolution stays under the retained original profile descriptor or fails; replacement bytes are never adopted
- [x] **Scenario: PI-001 remains unchanged**
  - **Given** configured and unconfigured project-guidance cases
  - **When** the resolver and existing startup composition are tested
  - **Then** unconfigured consumers receive none and configured bytes retain declared order, exact contents and source labels
- [x] The normalized type and error codes are exported independently of `AgentManager` and runtime-home materializers.
- [x] No plugin path, plugin lock, plugin assignment or plugin runtime projection is read or written.
- [x] Focused tests cover schema/version errors, missing profile, compatibility mode, conflicting
  model/provider, explicit inheritance, secret redaction, mutable/symlinked references and reload determinism.

## Non-goals

- Adding the compact `tachyon.yml` profile reference, migration command, backup/rollback or YAML
  round-trip; those belong to `t-4f82e0`.
- Materializing `config.toml`, MCP, hooks, skills, prompt files, secrets or runtime homes.
- Activating Soul, Evolution, memory or capability authority; this slice may resolve their declared
  references, while their existing authority owners remain decisive.
- Changing Agent Studio, create/edit/rename/clone/forget/import/export flows.
- Changing workspace plugin installation or designing agent-scoped plugins.
- Removing the legacy stanza compatibility mode.

## Open questions

None. SDD 423 and Task `t-17a2c2` fix the source, precedence and scope boundaries for this slice.
