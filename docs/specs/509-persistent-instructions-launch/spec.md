# 509 — persistent-instructions-launch

_Created 2026-08-15._

**Status:** shipped
**Closure:** Shipped for `t-d3ace4`: all three launch projectors, fail-closed transport bounds, named red paths, and runtime parity/documentation; exact-tree evidence is recorded in the task journal.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Persistent profile instructions currently travel only inside the startup brief, which is transcript content and can be discarded by compaction. Project the already-resolved `AgentEntry.instructions` into each measured runtime's launch-level instruction channel so the layer is owned by the runtime rather than by a model-written summary.

The projection is Claude file-backed, Grok `--rules`, and Codex `developer_instructions`. Empty profiles add no flag. A common measured transport ceiling fails closed with a named error; nothing truncates. Claude automatic-compaction survival remains explicitly `cannot`, not inferred from the launch mechanism.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: profile instructions reach every supported launch**
  - **Given** a canonical Claude, Codex, or Grok agent whose profile resolves non-empty persistent instructions
  - **When** Tachyon composes spawn or restart
  - **Then** the runtime command contains its measured launch projection and the ordinary startup brief remains deliverable
- [x] **Scenario: absent instructions stay absent**
  - **Given** an agent with no resolved persistent instructions
  - **When** Tachyon composes its launch
  - **Then** no persistent-instruction flag or empty value is added
- [x] **Scenario: oversized projection is legible**
  - **Given** instructions whose exact launch representation exceeds the common measured transport ceiling
  - **When** Tachyon prepares the launch
  - **Then** preparation fails before pane replacement with agent, runtime, byte count and ceiling; no truncation occurs
- [x] A red-path regression names Claude, Codex and Grok independently when that runtime's product projection is removed.
- [x] Runtime parity declares the dimension using `wired`/`measured`/`cannot`; Claude automatic compact remains recorded as `cannot` in human-facing documentation.

## Non-goals

- Re-resolving or repinning `instructions.md`; `agentProfileProjection` remains the source.
- Projecting through plugin hooks or changing `tachyon.yml`.
- Claiming a semantic/model maximum or completed Claude automatic compact.
- Hiding same-user argv/session-artifact exposure with encryption or a secret store.

## Open questions

None. The runtime channels were fixed by the measurements in `docs/research/t-a68138-system-prompt-compact.md`.
