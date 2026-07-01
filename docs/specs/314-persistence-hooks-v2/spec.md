# 314 — persistence-hooks-v2

_Created 2026-07-01._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Spec 312 moved automatic continuity/handoff maintenance from visible terminal nudges into runtime-native hooks for
persisted Claude/Codex agents. That solved the user-visible spam, but v1 is intentionally small: it does not yet expose
whether hooks are actually healthy, does not durably log hook script failures, has only lightweight Stop ledger proof,
keeps the kill switch config-only, and does not attempt semantic handoff drafting.

This umbrella coordinates the v2 work as a sequence of small specs. Done means the follow-up work is split into
independent contracts with a clear order, shared boundaries, and no regression of the spec 312 rule: persistence should
be silent for the human when hook injection is active, and visible fallbacks should remain only when hooks were not
injected.

## Acceptance criteria

- [ ] **Scenario: ordered v2 backlog**
  - **Given** spec 312 has shipped
  - **When** Tachyon plans persistence-hooks v2
  - **Then** the work is decomposed into child specs for dogfood proof, diagnostics, failure logging, settings UI,
    retention, and semantic handoff candidates
- [ ] **Scenario: implementation order is observability-first**
  - **Given** the Stop hook path is the least proven runtime behavior in v1
  - **When** choosing the first child spec to implement
  - **Then** minimal failure capture and bounded evidence are established before any UI polish or semantic automation
- [ ] **Scenario: silent-by-default invariant is preserved**
  - **Given** a persisted Claude/Codex agent has the silent persistence hook bundle injected
  - **When** any child spec changes observability, logging, or configuration
  - **Then** Tachyon does not reintroduce automatic pane-typed continuity/handoff nudges for that agent
- [ ] Specs 315-320 exist and each owns one concern.
- [ ] This umbrella records dependency order and shared non-goals without implementing child behavior directly.

## Non-goals

- Implement any child behavior directly.
- Reopen the spec 312 policy that ad-hoc/fork/probe agents are persistence-off by default.
- Fabricate project handoff notes from hooks without an explicit candidate/review design.
- Replace the existing explicit `append_project_handoff_note` and `set_continuity` bridge tools.
- Publish or package a release solely for the umbrella.

## Open questions

- **OQ1 — Child spec order.** Proposed execution order after Claude review: 315 Stop hook dogfood with explicit manual
  failure checks, 317 failure log, 319 retention, 316 health diagnostics, 318 settings UI, 320 semantic handoff
  candidates. The numeric IDs were allocated before this review; execution order is the list above, not numeric order.
  Owner must ratify before implementation starts.
- **OQ2 — Diagnostic surface.** Initial recommendation: start with Inspector/Sidebar status plus machine-readable state;
  exact UI placement belongs to spec 316.
