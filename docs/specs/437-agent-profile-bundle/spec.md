# 437 — agent-profile-bundle

_Created 2026-07-22._

**Status:** shipped
**Closure:** Shipped by task `t-999e4f`: deterministic V1 export/import/clone, lifecycle-staged authored documents, Workspace routing, focused tests, dogfood and full verification.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Verify:** `npm run verify:full:quiet`
**Verify:** `npm run typecheck`
**Dogfood:** `npx vitest run test/unit/agentProfileBundle.test.ts test/unit/workspaceHeadless.test.ts`

## Intent

Canonical profiles are safe inside one workspace, but there is no safe interchange boundary. Copying the on-disk profile would transfer identity, host authority, secret handles, derived state and machine-local paths; the existing legacy clone copies a definition without the canonical lifecycle guarantees.

Define a deliberately small portable V1 document and one import transaction. Export projects only positively allowlisted authored settings plus profile-local Soul/instructions bytes. Import and clone parse the exact same canonical bytes, mint a fresh `agentId`, initialize empty local authority, materialize validated content atomically, and create the destination disabled. Excluded capabilities and bindings are represented only by content-free reauthorization requirements.

**Affected Product Invariants: none.** PI-001 governs project-guidance ownership; bundles do not carry project guidance and do not alter prompt composition rules.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: deterministic secret-free export**
  - **Given** a valid canonical profile with host authority, secrets, capabilities, projections and optional profile-local Soul/instructions
  - **When** it is exported twice
  - **Then** both canonical JSON byte sequences and digests match, include only the V1 allowlist, and contain no source `agentId`, authority, grants, secret values/handles, paths, plugins, learned state or runtime projections
- [x] **Scenario: staged import creates a fresh inert identity**
  - **Given** valid V1 bytes and a free destination name
  - **When** import commits
  - **Then** all bytes validate before publication, a fresh random `agentId` is minted, authored documents are materialized with verified digests, authority starts without transferred grants, and the profile is disabled pending local enable/reauthorization
- [x] **Scenario: clone cannot bypass portability**
  - **Given** a source canonical profile
  - **When** it is cloned
  - **Then** clone exports canonical V1 bytes and invokes the exact import parser/transaction, producing the same result as external import with a fresh identity
- [x] **Scenario: hostile input fails closed**
  - **Given** oversized, malformed, deeply invalid, unknown-version, unknown-field, traversal-shaped or symlink-sourced input
  - **When** import is attempted
  - **Then** it is rejected before canonical profile, authority or locator publication and no destination state is left behind
- [x] **Scenario: collision and crash are recoverable**
  - **Given** an occupied destination or interruption during create publication
  - **When** import/recovery runs
  - **Then** no existing identity is overwritten; unpublished staging is removed or the existing lifecycle transaction deterministically compensates
- [x] Exported reauthorization requirements contain only field/kind labels and reference IDs that were already human-authored; secret providers/IDs and values are never included.
- [x] V1 is one regular UTF-8 JSON document with bounded bytes/strings/arrays, recursively sorted object keys, preserved array order, no timestamp and no archive extraction.

## Non-goals

- Portable plugin, skill, memory, Evolution, transcript, cache, worktree, project-guidance, secret or runtime-home content.
- Generic bundle-version migration framework; V1 rejects every other version.
- Content-level secret detection inside user-authored Soul/instructions text. “Secret-free” means no host-custodied credential fields are exported; authored text is copied verbatim.
- Agent Studio file picking/presentation; that belongs to `t-149877`.

## Open questions

None. Architecture review `probe-d43d3e34-0d1a-4787-bd0a-fe7984307266` fixed the V1 boundary before implementation.
