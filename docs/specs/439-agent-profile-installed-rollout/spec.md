# 439 — Agent profile installed rollout

_Created 2026-07-23._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

The canonical agent profile stack is implemented, but Tachyon's own installed workspace still declares
all five agents inline in `tachyon.yml`. The current migration path accepts only a minimal literal
Codex definition; it rejects Claude, Grok and the existing Codex Evolution selector. Agent Studio also
edits only a narrow canonical subset, so declaring the architecture complete would leave real
configuration stranded in the legacy writer.

This rollout closes that gap for the runtimes and fields used by this workspace, migrates the installed
fleet transparently, proves fresh/reload/resume behavior, and then removes the obsolete inline-agent
operational paths. A runtime becomes migratable only after its inspector and projector prove the same
forming inputs used at launch. The migration changes representation, never effective agent behavior.

Affected Product Invariants: **PI-001 — promise and fixed oracle unchanged.** Project Guidance remains
workspace-owned and opt-in. Profile migration records its dependency but does not copy, reorder or
reinterpret guidance. Plugin payloads, locks and workspace-wide scope remain untouched.

## Acceptance criteria

- [ ] **Scenario: every installed agent migrates without behavioral drift**
  - **Given** the five current inline agents (`claude`, `claude-orca`, `codex`, `grok`, `grok-x`)
  - **When** the installed migration completes
  - **Then** each stanza becomes the exact canonical pointer and its effective command, cwd, lifecycle,
    Evolution selection and workspace references remain equivalent
- [ ] **Scenario: runtime support is measured**
  - **Given** a Codex, Claude or Grok profile
  - **When** it is inspected, projected and launched
  - **Then** the selected adapter accounts for every forming runtime input it claims to support and
    unknown or overriding native input fails closed
- [ ] **Scenario: Studio edits canonical operational fields**
  - **Given** a new or migrated canonical agent
  - **When** the human edits runtime, role, cwd, lifecycle, worktree, isolation, verification,
    instructions or supported non-plugin capabilities
  - **Then** the explicit authored fields round-trip through revisioned profile mutation without using
    the legacy YAML writer or promoting derived/secret data
- [ ] Studio uses this ownership matrix:

  | Lane | Studio behavior in this rollout |
  |---|---|
  | runtime, role, cwd, lifecycle, worktree, isolation | writable authored profile fields |
  | verification/setup, persistent instructions, supported non-plugin capabilities | writable only after schema binding and runtime projection are measured; otherwise read-only/deferred |
  | Soul, Evolution, selected memory | dedicated protocol/action with provenance; never ordinary form CAS |
  | authority, secrets, runtime projection, workspace guidance, plugins | read-only provenance or external reference; never serialized as authored values |
- [ ] **Scenario: migration is transparent across sessions**
  - **Given** a migrated agent and a pre-migration session snapshot
  - **When** Tachyon performs fresh start, warm reload, resume or fork
  - **Then** the correct pinned/current profile is selected and no stale LKG, projection or authority
    silently changes behavior
- [ ] **Scenario: failures remain recoverable**
  - **Given** config failure, projection tampering, path/symlink attack, authority mismatch or interruption
  - **When** reload, spawn, reconciliation or rollback runs
  - **Then** Tachyon fails closed or restores the exact safe state without overwriting later human edits
- [ ] **Scenario: an interrupted installed cutover resumes deterministically**
  - **Given** zero to four agents have completed their independent migration transaction
  - **When** Tachyon or the operator is interrupted before the next agent passes its reload/fresh-launch barrier
  - **Then** startup reconciles the current single-agent journal, verifies every completed
    profile/authority/pointer tuple, and resumes from the first incomplete agent without rolling back
    unrelated completed agents
- [ ] **Scenario: plugins do not move**
  - **Given** workspace-installed plugins before profile migration
  - **When** agents are migrated and rematerialized
  - **Then** plugin payload, lock, scope and availability remain workspace-wide and no profile
    `plugins.yml` is created
- [ ] **Scenario: legacy runtime paths are retired**
  - **Given** this sole production workspace is migrated and installed dogfood passes
  - **When** the rollout closes
  - **Then** new inline-agent writes are impossible and obsolete legacy parser/writer/operational paths
    are removed; only compatibility code still required by a concrete unmigrated fixture remains
- [ ] Import/export excludes secrets, raw runtime homes, transcripts, caches and unselected memory.
- [ ] Evolution, Soul and selected-memory ownership remain separate from ordinary authored form fields.
- [ ] PI-001 and the existing plugin non-interference contract remain green.

## Non-goals

- Designing or installing agent-scoped plugins.
- Centralizing runtime transcripts, logs, caches, databases or harness homes.
- Treating arbitrary Claude/Grok native configuration as trusted canonical input.
- Adding deprecation telemetry or a multi-release compatibility period for other users; Tachyon
  currently has one production workspace.
- Redesigning runtime-managed memory; its parity/architecture discussion remains in its dedicated Task.

## Open questions

None. The user ratified migration of all five installed agents; support may ship in ordered slices, but
the rollout is not complete while any of those agents remains inline.
