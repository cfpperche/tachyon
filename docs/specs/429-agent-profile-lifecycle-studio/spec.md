# 429 — Agent profile lifecycle and Studio

_Created 2026-07-22._

**Status:** in-progress

**Task:** `t-e50d4f` (slice 6 of `t-7d2cc0`)

**Affected Product Invariants: none —** the active registry contains only PI-001, whose project-guidance ownership promise and fixed oracle are unchanged. Every implementation follow-up must repeat this declaration before code and run the invariant gate if prompt composition changes.

## Intent

The profile resolver is now authoritative at launch, but the product still edits agent definitions through legacy `tachyon.yml` writers and performs lifecycle operations through unrelated one-off paths. Agent Studio can therefore display a resolved agent and then save it through a different source of truth. Rename, clone and forget likewise do not yet share the profile's identity, authority or recovery contract.

This specification closes that product seam. One host-owned lifecycle service becomes the exclusive mutation boundary for canonical profiles. Agent Studio consumes revisioned, redacted snapshots from that service and submits explicit intents; it never serializes learned values, runtime projections or external authority back into `agent.yml`. Because the work spans four independently reviewable trust boundaries, this task coordinates four ordered follow-ups rather than shipping one oversized patch.

## Delivery decomposition

1. `t-f447c4` — lifecycle kernel: redacted snapshot/provenance, opaque CAS revision, journal/recovery, create/edit and enable/disable.
2. `t-c111e4` — identity/destructive lifecycle: rename and forget, preserving identity and external ownership.
3. `t-999e4f` — portable bundle: secret-free export, staged import and clone with a fresh identity and no transferred authority.
4. `t-149877` — Agent Studio integration: typed protocol, provenance/conflict UI, localization, accessibility and installed dogfood.

Tasks 2 and 3 may proceed in parallel after task 1. Task 4 integrates both.

## Contract

- The lifecycle service owns canonical mutation. Generic YAML writers may continue serving legacy agents but cannot edit a profile-backed agent.
- Every read returns an opaque revision binding the canonical profile and relevant authority inputs. Every mutation supplies that revision and fails with a redacted conflict if stale.
- Multi-file operations use durable intent, staged writes, one documented external commit point, idempotent recovery and explicit degraded diagnostics. Runtime registration changes only after canonical commit.
- `enabled` has one canonical representation. A disabled profile remains inspectable but cannot launch or autostart.
- Rename preserves `agentId`; clone and import allocate a new `agentId`. Authority, grants, secret values and runtime projections are never copied.
- Forget removes only an explicit allowlist of Tachyon-owned canonical bytes and disposable projections, retires the locator/authority before final deletion, and cannot delete external resources, workspace plugins or runtime-managed memory.
- Export uses a versioned portable schema distinct from the on-disk layout. It contains only human definition and explicitly exportable content, with `requiresReauthorization` markers.
- Studio fields carry value, origin/scope, writability/authority and conflict state. Only explicit user edits become a canonical patch.

## Acceptance criteria

- [ ] **Scenario: create and edit use one canonical transaction path**
  - **Given** a new or profile-backed agent and a current revision
  - **When** a human creates or edits it
  - **Then** the canonical profile, authority head and `tachyon.yml` locator converge atomically or recover to a diagnosable prior/degraded state
- [ ] **Scenario: stale and unauthorized edits fail closed**
  - **Given** two clients or an externally authoritative field
  - **When** a stale or forbidden patch is submitted
  - **Then** no partial write occurs and the caller receives a secret-free field-level conflict
- [ ] **Scenario: enablement is canonical**
  - **Given** a disabled profile
  - **When** any launch or autostart path evaluates it
  - **Then** launch is refused while inspection and a revision-checked enable action remain available
- [ ] **Scenario: identity operations preserve their distinct semantics**
  - **Given** rename, clone and import requests
  - **When** they commit
  - **Then** rename retains the original `agentId`, while clone/import create a fresh one and copy no authority or secret
- [ ] **Scenario: forget cannot erase external ownership**
  - **Given** an agent with owned projections and external bindings
  - **When** forget is confirmed
  - **Then** retirement and owned cleanup are recoverable, external stores remain intact, and name reuse is blocked until retirement commits
- [ ] **Scenario: portable round-trip is explicit and secret-free**
  - **Given** a profile with learned, projected, authority-gated and human-authored sections
  - **When** it is exported and imported
  - **Then** only allowed content round-trips and every inactive authority-gated lane is marked for reauthorization
- [ ] **Scenario: Agent Studio preserves provenance**
  - **Given** canonical, learned, projected and externally authoritative values
  - **When** Studio displays and saves an explicit edit
  - **Then** origins and conflicts remain visible, secrets remain absent, and derived values are not promoted into canonical data
- [ ] Recovery, concurrent edits, path custody, accessibility, localization and installed Visual QA are covered by the follow-up evidence.
- [ ] Existing legacy agents and workspace-wide plugins retain their current behavior.

## Non-goals

- Agent-scoped plugin installation or changing workspace plugin scope.
- Runtime-managed memory architecture.
- Moving secrets or authority records into the agent root.
- Replacing the resolver, runtime projection adapters or Evolution approval model.
- A raw unrestricted YAML editor for canonical profiles.

## Open questions

None at the umbrella level. Each follow-up must resolve its operation-specific commit point before implementation.
