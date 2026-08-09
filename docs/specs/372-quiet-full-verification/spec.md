# 372 — quiet-full-verification

_Created 2026-07-11._

**Status:** shipped
**Closure:** shipped in `043c79e` with coordinator-audit corrections in `89b3489`; final quiet dogfood passed
301 files and 3,558 tests (3 skipped) with bounded output, typecheck/diff-check green, and no temporary-directory growth.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Verify:** `npx vitest run test/unit/verifyFullQuiet.test.ts`
**Verify:** `npm run typecheck`
**Dogfood:** `npm run verify:full:quiet`

## Intent

Tachyon's declared full-verification command currently streams successful esbuild and Vitest output into every
executor, reviewer, and coordinator transcript. A successful run contributes roughly 7–8 thousand avoidable tokens;
repeated verification and persistent agent histories amplify that output into model rate-limit pressure without
adding evidence beyond the final counters.

Add a quiet full-verification command that executes the same build and complete test suite but emits only a bounded
success summary or relevant bounded failures. Make it the project orchestration default while preserving the current
verbose command for human debugging.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: successful full verification is transcript-bounded**
  - **Given** the build and every Vitest test pass
  - **When** `npm run verify:full:quiet` runs
  - **Then** it executes the full build and test suite, exits zero, and prints a correct summary below 1 KiB without
    listing passed bundles, files, suites, or tests
- [x] **Scenario: failures remain actionable without flooding context**
  - **Given** the build, test infrastructure, or assertions fail
  - **When** quiet verification exits non-zero
  - **Then** it prints the failed phase and bounded relevant diagnostics, omits successful noise, and identifies a
    private retained full log or the verbose rerun command
- [x] **Scenario: orchestration defaults to quiet while verbose remains available**
  - **Given** a newly composed Tachyon agent primer or full `verify_task` gate
  - **When** it resolves `settings.verify.full`
  - **Then** it uses `npm run verify:full:quiet`, while explicit `npm run verify:full` retains verbose behavior
- [x] Quiet and verbose modes run the same `node esbuild.mjs` then complete `vitest run` workload; reporter/output
  policy may differ, test selection and pass/fail semantics may not.
- [x] Successful temporary logs are removed; failed logs are private, outside tracked Git state, and named in output.

## Non-goals

- Reducing verification frequency, coverage, test selection, or review rigor.
- Changing esbuild outputs, Vitest test semantics, or the generic `verify_task` default for other projects.
- Solving every source of model rate limiting or rotating persistent agent sessions in this change.
- Building a general process supervisor, log viewer, or CI reporting framework.

## Open questions

None. The maintainer ratified quiet-by-default orchestration with explicit verbose fallback on 2026-07-11.
