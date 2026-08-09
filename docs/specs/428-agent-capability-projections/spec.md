# 428 — Agent capability projections

_Created 2026-07-22._

**Status:** shipped

**Closure:** Shipped task `t-a34bb7`. Agent-selected skills, MCP servers, classified hooks, and explicit Pi resources now resolve from digest-bound captured bytes, join host-custodied authority where required, and materialize into disposable private runtime projections with provenance. Three independent probe passes shaped and verified the trust boundary. Final proof: 121 focused tests, dogfood pass, typecheck pass, and full suite 5399 passed / 3 skipped.
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
**Dogfood:** `npx vitest run test/unit/agentProfileConfigLoader.test.ts test/unit/harness.test.ts`

**Task:** `t-a34bb7` (slice 5 of `t-7d2cc0`)

**Affected Product Invariants: none —** the active registry currently contains only PI-001 (project-guidance ownership), whose promise and fixed oracle do not cover agent capability declaration or runtime projection. This behavior receives focused regression and integration coverage; creating a new Product Invariant would require separate maintainer ratification.

## Intent

An agent profile can already select `skill`, `mcp`, and `hook` references, while Tachyon's existing harness can already write those capabilities into private runtime homes. The missing layer is the safe join between them. Today a selected reference either blocks profile projection or would have to fall back to untracked paths and runtime-native files with no durable provenance.

This slice makes non-plugin capabilities part of the resolved agent definition. It resolves exact source bytes, applies external consent where executable authority is required, detects collisions, and hands the existing runtime adapters a digest-bound projection. A generated manifest records what was projected; it never becomes a source of truth. A fresh materialization always starts from the canonical declaration and current authority.

## Contract

The four stages are distinct:

1. **Declaration/selection** — `agent.yml` selects typed reference IDs. Agent-local bytes stay below the agent profile; shared bytes stay in their project/product-owned scope.
2. **Authority** — a profile request is not consent. MCP launchers and executable hooks require a matching host-custodied grant. Secret values never enter the profile or manifest.
3. **Resolution** — Tachyon reads the selected source without following symlinks, captures the exact regular-file bytes (or deterministic no-follow tree), verifies its declared digest, classifies hooks, rejects malformed or colliding capabilities, and binds the result into `effectiveSha256`.
4. **Projection** — the existing private-home adapter receives only that captured snapshot, never a path to re-read. It rebuilds owned runtime files and writes a provenance/integrity manifest after successful materialization.

Hook classes are `capability`, `prompt-transform`, `observability`, and `enforcement`. Every executable hook requires consent; an enforcement hook additionally requires a grant that explicitly authorizes the `enforcement` class. A declaration cannot relabel a grant.

Pi resources use typed selectors for `extensions`, `skills`, `prompts`, `themes`, and `packages`. Their canonical source remains at its declared owner scope; disposable digest-bound bytes may be copied into the private Pi generation without changing that ownership.

The activation matrix is deliberately small: Codex profile projections support skills, MCP, and hooks; Pi profile projections support its five explicit resource kinds through the already content-addressed SDD 406 path. Every other adapter/kind pair fails explicitly. Widening this matrix requires a measured native-input/consumption contract and is not inferred from the mere existence of a legacy harness writer.

## Acceptance criteria

- [x] **Scenario: selected local and shared capabilities resolve with provenance**
  - **Given** an agent profile selects pinned local and project-owned skills/resources whose source digests match
  - **When** the profile is resolved
  - **Then** the effective snapshot records each reference's original scope, owner, path, type, and resolved digest without creating an agent-owned canonical source copy of shared bytes

- [x] **Scenario: executable capability authority is joined externally**
  - **Given** selected MCP and hook declarations plus host-custodied grants bound to their reference IDs, digests, and hook classes
  - **When** the profile is resolved
  - **Then** only exactly granted declarations become active, `${VAR}` secret references remain unresolved on disk, and literal secrets, missing grants, changed digests, or a mismatched enforcement class refuse activation

- [x] **Scenario: unsafe or ambiguous input fails closed**
  - **Given** a selected source traverses a symlink, changes while read, has the wrong digest/type, or collides with another projected runtime name
  - **When** Tachyon resolves or materializes it
  - **Then** launch is refused before the runtime consumes a partial or ambiguous capability set

- [x] **Scenario: runtime projections are disposable and self-describing**
  - **Given** a valid resolved capability snapshot
  - **When** Tachyon materializes the agent's private runtime home
  - **Then** runtime-native skills/MCP/hooks/Pi resources are rebuilt from the captured bytes and a secret-free manifest binds the effective profile, source provenance, and projected payload digests

- [x] **Scenario: projection divergence never becomes authority**
  - **Given** a prior runtime projection or its manifest was edited, deleted, or left incomplete
  - **When** the next fresh materialization runs
  - **Then** Tachyon replaces it from current resolved sources or refuses on source/authority failure; it never imports edited projection bytes into the profile

- [x] **Scenario: measured adapter support is explicit**
  - **Given** Codex skills/MCP/hooks, Pi explicit resources, or another adapter/kind pair
  - **When** a resolved projection is requested
  - **Then** the two measured mappings are exercised, every other pair fails with a precise error, and no ambient runtime capability source outranks the projection

- [x] Existing workspace-wide plugin discovery, installation, lock, consent, and projection behavior is byte-for-byte outside this profile schema and unchanged by capability materialization.
- [x] Legacy inline `harness:` declarations remain compatible; the new profile-only provenance fields cannot be authored through `tachyon.yml`.

## Non-goals

- Per-agent plugin installation, plugin assignment, plugin locks, or plugin consent. Those remain in `t-f095b5` and `t-54cdb1`–`t-54cdb4`.
- Runtime-managed memory or human-selected memory (`t-d4c42e`).
- Moving secrets or consent records into `.tachyon/agents/<agent>/`.
- Replacing existing runtime adapters or changing workspace-wide plugin semantics.
- Agent Studio create/edit/clone/rename/forget orchestration, owned by later lifecycle slices.

## Open questions

None. The independent design review ratified the bounded Codex + Pi activation matrix above.
