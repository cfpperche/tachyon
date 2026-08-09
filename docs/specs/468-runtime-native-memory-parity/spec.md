# 468 — runtime-native-memory-parity

_Created 2026-07-26._

**Status:** shipped
**Closure:** Measured six installed runtimes, defined a fail-closed evidence
contract, added parity dimension 15 and created the implementation roadmap
under `t-8c7431`; no runtime memory behavior was enabled.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`

## Intent

Measure runtime-managed native memory as a distinct trust boundary for every
first-class runtime, then define the smallest adapter capability contract that
can truthfully describe whether Tachyon can detect, disable, enable, isolate,
observe, export and forget that memory. This research must not create a second
implementation of Tachyon's human-approved selected-memory lane.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] The inventory covers Claude, Codex, Grok, OpenCode, Pi and Hermes using
  installed-version evidence and primary runtime documentation/source.
- [x] Each runtime records producer, injected bytes, storage/scope, lifecycle,
  disable/enable controls, observability, export/forget and isolation behavior.
- [x] The proposed capability distinguishes declared control from behaviorally
  verified control and fails closed when the runtime or version is unknown.
- [x] The architecture keeps runtime-managed bytes outside the canonical
  human-approved memory activation head.
- [x] `docs/runtimes/parity.md` gains an evidence-linked memory dimension.
- [x] Every concrete implementation gap becomes a bounded follow-up task.

## Non-goals

- Implementing a memory store, prompt lane, Control/Studio UI, endpoint or
  runtime adapter.
- Copying raw transcripts, indexes, databases or provider credentials into an
  agent profile.
- Treating conversation resume/compaction or human-authored instruction files
  as runtime-managed memory.

## Open questions

None. Declared and verified evidence are separate states; external providers
are represented as an external mechanism/store boundary with credentials and
raw provider state excluded from the profile.
