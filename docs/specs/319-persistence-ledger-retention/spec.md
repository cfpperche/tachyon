# 319 — persistence-ledger-retention

_Created 2026-07-01._

**Status:** shipped
**Closure:** Shipped in this workspace as spec 319 implementation; final commit/VSIX recorded after validation. Evidence: `npm test -- test/unit/sessionOwners.test.ts test/unit/harness.test.ts` and `npm run typecheck`.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Spec 312 introduced `persistence-stop.jsonl`, and spec 317 is expected to add a failure log. These files are activity
state, not permanent project history. Without retention, a long-running workspace can accumulate noisy local ledgers
forever.

Done means Tachyon has a simple, deterministic retention policy for persistence hook ledgers/logs that bounds disk usage
without deleting the recent evidence needed by diagnostics and dogfood. Scope includes the spec 312 Stop ledger and the
spec 317 failure log; otherwise v2 would leave the highest-churn diagnostic file unbounded.

## Acceptance criteria

- [x] **Scenario: retention prunes old Stop rows**
  - **Given** `persistence-stop.jsonl` exceeds the chosen retention bound
  - **When** Tachyon performs maintenance
  - **Then** old rows are pruned or rotated while recent rows remain available
- [x] **Scenario: retention preserves diagnostic usefulness**
  - **Given** hook health diagnostics needs recent success/failure evidence
  - **When** retention runs
  - **Then** the latest row per relevant agent/event is preserved within the configured window
- [x] **Scenario: corrupt lines are tolerated**
  - **Given** a ledger contains partial or malformed JSONL lines
  - **When** retention runs
  - **Then** Tachyon does not crash and keeps valid recent evidence
- [x] The retention policy applies consistently to Stop ledger and hook failure log.
- [x] Retention defaults are documented and do not require user configuration for normal use.
- [x] Retention planning records any minimum data window required by spec 320 before finalizing pruning defaults.

## Non-goals

- Sync activity ledgers across machines.
- Treat hook ledgers as durable project history.
- Build a full log viewer.
- Store semantic handoff content.

## Open questions

- **OQ1 — Bound type.** Choose between max rows, max bytes, max age, or a hybrid after inspecting existing activity log patterns.
- **OQ2 — Semantic candidate dependency.** If spec 320 needs cross-session history, that minimum window must be known
  before retention ships.
