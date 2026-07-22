# 430 — Agent profile lifecycle kernel — notes

_Created 2026-07-22. Append-only by convention._

## Design decisions

- Affected Product Invariants: none; PI-001 remains unchanged.
- Enablement is canonical profile data, absent=true, and reaches AgentManager only through trusted internal loader metadata.
- The transaction's authority is the proven tuple, not any one filesystem or SecretStorage write.
- Probe `probe-5a1ba4d7-1ab9-4c37-8726-47033428854e` required versioned authority CAS and one shared coordinator/lock with migration. Both corrections were folded before implementation.
- The probe's grant-erasure concern is addressed by excluding authority/grants from lifecycle patches; grants are preserved from the current authority record under lock.

## Deviations

None.

## Tradeoffs

- Whole-profile targets make edits less granular but keep derived/provenance-bearing values out of canonical serialization.

## Review evidence

- `/home/goat/tachyon/.tachyon/probes/probe-5a1ba4d7-1ab9-4c37-8726-47033428854e/result.json`
- Implementation review: `probe-bc6687d6-b32a-4d2a-90a0-17bfa28f1835`; full findings at `/home/goat/tachyon/.tachyon/probes/probe-bc6687d6-b32a-4d2a-90a0-17bfa28f1835/result.json`.
- The review's concrete findings were folded in: declared names cannot bypass disablement with an explicit command; adapter changes require authority migration; authority CAS is structural; host activation occurs before journal commit; existing transaction directories and private files are validated/no-follow.
- Recovery does not steal a live cross-process lock: the shared coordinator checks the recorded PID and refuses reclamation while that owner is alive. Same-process recovery is restricted to startup reconciliation before mutation APIs are exposed.
- Post-fix review: `probe-6a96a1fd-0a9f-4490-8d80-70bcf5a8651f`.
- That review found the remaining durable/live activation window. The journal now records `activated`; recovery activates converged targets before commit, compensation reactivates the prior tuple, and degraded compensation forces a live launch block.
- Closure review `probe-22fffaa1-46d9-495b-a312-6cc4b4517554` found two final omissions: activation is now a required port and successful activation clears only the matching live spawn block.

## Verification evidence

- Focused lifecycle, migration, loader, AgentManager and headless Workspace suites: 504/504 passed after review fixes.
- Pre-review full gate baseline: 473 files passed; 5411 passed, 3 skipped.
- Final configured gate: 473 files passed; 5414 passed, 3 skipped. Typecheck passed.

## Open questions

None.
