# 475 — probes-effective-model-column

_Created 2026-07-26._

**Status:** shipped
**Closure:** Shipped in the t-3a3de1 worktree: `effectiveModel` sourced from each run's own stored
provenance, a single unambiguous model cell derived in `probeView` (proven / mismatch / unproven /
reported / none), carried across the engine wire contract, and rendered between `runtime` and
`archetype`. Visual QA found and fixed three readability regressions. Evidence:
`npm run verify:full:quiet` (520 files, 5842 tests), `npm run dogfood:probes-model-column` (7/7), and
the wide/narrow screenshots under `evidence/`.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

The Control Probes table shows id, status, reason, runtime, archetype, caller, age and excerpt — but
not which model produced the answer. Someone auditing "was this review really run on Opus 5?" has to
open the stored artifact, which is exactly the friction SDD 473 and 474 built the data to remove.

Those specs established the facts and the discipline: the requested model is what a caller asked
for, the effective model is what the runtime reported running, and the two are never interchangeable
— absence of evidence is recorded as `unproven`, never filled in from the request.

This spec puts that on screen without eroding it. The hard part is not adding a column; it is making
a single cell that can say "this ran on `grok-4.5-build`", "this ran on something other than what
you asked for", "nobody can prove what this ran on", and "nothing was asked for" — each
distinguishable at a glance, in a table that already carries eight columns.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: a proven run shows the model that ran**
  - **Given** a probe whose runtime reported running the requested model
  - **When** the Probes table renders
  - **Then** the model cell shows that effective identifier.
- [x] **Scenario: a mismatch is visibly not the requested model**
  - **Given** a probe requested with one model whose runtime reported another
  - **When** the table renders
  - **Then** the cell shows the effective identifier marked as differing, and names the requested
    model so the discrepancy is readable without opening the artifact.
- [x] **Scenario: an unprovable run never borrows the requested model**
  - **Given** a probe that requested a model and whose runtime reported none
  - **When** the table renders
  - **Then** the cell reads `unproven` and does NOT display the requested identifier as though it
    were effective.
- [x] **Scenario: a run that asked for nothing is not an error state**
  - **Given** a probe with no requested model
  - **When** the runtime reported an effective model
  - **Then** the cell shows that identifier; and when the runtime reported none, the cell reads `—`
    rather than `unproven`.
- [x] **Scenario: a still-running probe makes no claim**
  - **Given** a probe with no stored result yet
  - **When** the table renders
  - **Then** the model cell makes no assertion about which model is running.
- [x] The cell never prints a requested identifier in the position where an effective identifier
  would appear.
- [x] Long provider-native identifiers (e.g. `claude-haiku-4-5-20251001`) wrap or truncate without
  pushing the table into horizontal overflow at a narrow panel width.
- [x] The effective identifier reaches the view from the stored run's own provenance, not from any
  agent-declared model.
- [x] Historical runs stored before this provenance existed render as `unproven`/`—`, never as a
  model they cannot support.

## Non-goals

- Changing how provenance is captured, verified or enforced — SDD 473/474 own that; this spec only
  displays it.
- Making Codex probes provable (`t-a10d31`).
- Adding a second column for the requested model — one cell with unambiguous semantics, per the
  plan's rejected alternative.
- Sorting, filtering or grouping the table by model.
- Publishing a release or touching Marketplace state.

## Open questions

None.
