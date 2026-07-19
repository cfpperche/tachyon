# 411 — startup-brief-semantics — notes

_Created 2026-07-19._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-19 — Treat the current launch pointer/env payload as the freshness witness and retain
  unreferenced brief files only as derived postmortem residue. Rejected a timestamp/correlation
  sidecar for v1 because it would duplicate lifecycle state, introduce cleanup/drift, and tempt
  callers to treat a derived artifact as task/Delivery authority.
- 2026-07-19 — Long startup files gain a bounded inventory followed by the pre-existing flattened
  body as an exact contiguous suffix. Rejected per-layer re-rendering because spec 377 deliberately
  preserves legacy whitespace and precedence; typed metadata can explain composition without
  rewriting project/task bytes.
- 2026-07-19 — Spec 377's immutable BASE fixture remains byte/hash validated, including its old
  `spawn contract` pointer. The parity test now marks only that current seam as intentionally
  superseded and points to SDD 411's focused oracle; rewriting the historical fixture was rejected
  because it would erase provenance rather than approve the product change.

## Deviations

- The typed-manifest and visible-pointer slices landed in the same foundational diff because the
  summary renderer is the executable consumer that proves the metadata is bounded and non-spoofable.
  Mission Control tasks remain separate for closure/accounting, but splitting the shared type/API
  change into artificial intermediate commits would leave an unused abstraction.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

None.

## Baseline

- Base: `b75cd4f2890bfc5592b1c06bcfb0f04afdd96e54` in managed worktree
  `tachyon/change/startup-brief-semantics`.
- Dependencies: `npm ci` completed; package audit reported the repository's existing 5 advisories
  (2 low, 2 moderate, 1 high). No automatic fixes were applied.
- Focused command: `npx vitest run test/unit/soul-lifecycle-a2Behavior.gen.test.ts test/unit/briefFile.test.ts test/unit/snBriefBehavior.gen.test.ts test/unit/cxBriefBehavior.gen.test.ts test/unit/agentManager.test.ts --maxWorkers=1` — PASS, 5 files / 409 tests.
- `npm run typecheck` — PASS.
- `npm run verify:full:quiet` — FAIL, 7 tests; retained log
  `/tmp/tachyon-verify-full-g7Mv3N`. Six failures match the current primary-checkout baseline
  (`/tmp/tachyon-verify-full-dXC0NV`). The seventh is the already-documented managed-worktree
  PI-001 fixture issue: this repository's ignored local `tachyon.yml` is absent from a fresh linked
  worktree, so the invariant test cannot open it. Spec 408 records the same condition; no manual
  symlink/copy is used as verification evidence.
