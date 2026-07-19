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

## Implementation slices

- `0a1017b6 feat: make startup briefs self-describing (t-f5cb0d, t-fd63f7)` — typed composition,
  bounded manifest/inventory, AgentManager delivery, freshness/failure behavior and focused tests.
- Documentation/dogfood slice — aggregate-facing terminology audit, operator architecture,
  runtime-parity link, representative Codex/Hermes captures, completion discriminators,
  re-anchor isolation and explicit-resume non-injection.

## Dogfood log

- 2026-07-19 — `npm exec -- vite-node scripts/dogfood-project-guidance.mts` — PASS. The script
  exercises the real `AgentManager -> runtime adapter -> TmuxService argv/env` boundary for long
  guidance-only Codex positional and Hermes TUI delivery, structured `DELIVERABLE` and `DONE_WHEN`
  contracts, the separate re-anchor path, and a transcript-owning Codex resume command. It prints
  only synthetic, root-redacted bounded evidence and never the long body.

### 2026-07-19T15:36:01Z — pass (1/1) — source: tasks.md — commit: f432f3a570fb90c6c571cd2e642f8921e7da4e51
- `npm exec -- vite-node scripts/dogfood-project-guidance.mts` — pass

## Sanitized terminal/TUI evidence

The dogfood's generated root is replaced with `<workspace>`. The Codex positional command and Hermes
`HERMES_TUI_QUERY` both rendered this order:

```text
── TACHYON PRIMER ──
...
── END PRIMER ──

Your full startup brief is long (...) — written in full to <workspace>/.tachyon/briefs/spawn/worker.md.
Contains: project guidance (1 source); soul (absent); role (absent); persistent instructions (absent); Bridge guidance (absent); task contract (absent).
Task objective: absent — this launch supplied no task brief.
Read it before starting; this pane carries only the primer, this summary, the pointer, and the before-finishing reminder.

── BEFORE FINISHING ──
── END BEFORE FINISHING ──
```

The structured child captures differed only in bounded facts: `task contract (DELIVERABLE)` versus
`task contract (DONE_WHEN)`. The long re-anchor capture pointed to
`<workspace>/.tachyon/briefs/reanchor/worker.md` and left the startup file byte-identical. The
explicit `codex resume existing-session` capture received no startup body or Hermes query; only its
existing `TACHYON_AGENT_NAME` environment fact remained.

The referenced startup file began with this exact inventory before the unchanged long body:

```text
── STARTUP BRIEF CONTENTS ──
Project guidance: 1 source
Soul: absent
Role: absent
Persistent instructions: absent
Bridge guidance: absent
Task: absent
── END STARTUP BRIEF CONTENTS ──
```

Visual verdict: the primer, compact semantic summary, pointer and before-finishing reminder are
legible and correctly ordered in both supported TUI delivery channels; neither the bounded pane nor
inventory exposes the synthetic long guidance text.

## Candidate verification

- Focused startup/prompt/guidance/Workspace suite — PASS, 10 files / 516 tests.
- `npm exec -- vite-node scripts/dogfood-project-guidance.mts` — PASS with the sanitized evidence
  above.
- `npm run typecheck` — PASS on final candidate `f432f3a5`.
- Focused PI-001 behavioral promise — PASS, 1 test; the repository-fixture assertion was skipped by
  exact test-name selection because the ignored worktree config is not present.
- `npm run test:invariants` — FAIL only because the invariant runner also requires the ignored
  worktree-local `tachyon.yml`; the behavioral ownership oracle above remains green. The independent
  PI-001 equivalence review remains intentionally open.
- `npm run verify:full:quiet` — FAIL, 7 tests; retained log
  `/tmp/tachyon-verify-full-szjMOr`. Comparing failed-suite identities with the clean primary
  baseline `/tmp/tachyon-verify-full-dXC0NV` shows the same six pre-existing failures plus only the
  known worktree-local PI-001 fixture failure. No startup-brief-focused test failed and this result
  is not presented as green.
