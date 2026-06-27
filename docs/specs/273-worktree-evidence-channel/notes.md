# 273 — notes

## Origin
The "ship task-quality governance?" thread (2026-06-27) concluded NO — the verify-gate is already project-extensible
via runbooks. The one core-worthy gap (codex-validated CONFIRMED-WITH-CAVEATS, `…20260627T154057Z-…`): the gate
output is strictly binary, so non-binary evidence (advisories, per-step results, Visual-QA judgments + screenshots,
severities) has no home. This spec ships that neutral channel — the format, not the governance.

## Codex design dueto — SHIP-WITH-CHANGES (`…20260627T163131Z-…`), all folded
1. format couldn't hold per-step fields → added neutral `data` payload + `schemaVersion`.
2. `producer` was forgeable → host DERIVES it from the connection; client value rejected; `targetAgent` separate.
3. array-on-ledger persistence is racy → atomic append / append-only jsonl; never a handler RMW; concurrent-append test.
4. per-step records would pile up → `verifyRunId` + REPLACE the verify set per agent+commit (not append).
5. worktree-relative artifacts vanish on rebuild → Tachyon-managed evidence dir + path-traversal reject + missing-aware.
6. verify's `dirty` staleness over-stales evidence → evidence staleness is HEAD-only; `worktreeDirtyAtProduction` is informational.
7. summary privileging "judgment" reintroduces opinion → mechanical summary (counts + latest N), no special kind.
Cuts folded: minimal UI (count/stale only), no "latest judgment" in handoff, simple caps over ambiguous pruning.

## Integration points (verified in code)
- `Workspace.runVerify` `src/workspace/Workspace.ts:1414-1429` — runs `runbookRunner.runSteps` → `RunbookJob.steps`
  (`StepResult[]`), discards them, persists `VerifyState` via `this.ledger.recordVerify`. ← the per-step producer hook.
- `StepResult` `src/commands/RunbookRunner.ts:14-22` — `{index, step, cmd, exitCode?, durationMs?, state}`.
- `VerifyState`/staleness `src/worktree/verify.ts:14-52`; ledger record holds `verify?: VerifyState`
  (`WorktreeManager.ts:37`). `VerifyHandoff` (the MCP payload) `src/bridge/tools.ts`.

## Build complete — L1-L5 + I1 (commits `527749b`, `52f7d9a`, `b98affe`, + revision)
L1 pure store, L2 ledger persistence, L3 per-step producer, L4 bridge (attach/list/summary), L5 sidebar badge.
I1 headless dogfood = a bridge integration test driving the channel over a real MCP client (attach→list→traversal-
reject→producer-spoof-reject→verify_agent summary). Full suite green; typecheck(main+webview)+esbuild+engine-boundary.

## Codex I2 dueto on the BUILT code — NEEDS-REVISION, all folded
Transcript `…20260627T170806Z-…`. Fixes:
- **#1 concurrent verify race:** `replaceVerifySet` now keeps the NEWER prior verify set (by max producedAt) — an
  older-finishing run can't clobber a newer one. + test.
- **#2 reserved-producer spoof:** `attachEvidence` rejects a self-declared `producer:"verify"` (would impersonate
  built-in step-results AND be silently dropped by replacement). + bridge test.
- **#3 artifact durability:** narrowed the contract — worktree-relative, traversal-checked, NON-DURABLE refs (copy
  deferred), instead of a durability-shaped API that doesn't copy.
- **#4 getEvidence by-ref:** returns a COPY (callers can't bypass caps/replacement).
- **#5 stale severity lighting the badge:** added `freshBySeverity`; the badge tints warn/error on FRESH only.
- **#6 no-commit-anchor write:** `attachEvidence` rejects when the worktree HEAD is unresolvable (record would be
  born permanently stale).
- **#7 per-step id collision:** ids carry a per-Workspace sequence suffix (unique even within a tick).
- **#9 input clamping:** `capOldest`/`summarizeEvidence` clamp `max`/`latestN` >= 0.
- #8 (skipped→warn) kept: a producer legitimately assigns severity (the FORMAT stays neutral).
Deferred follow-up: the managed-dir artifact COPY for durability (Visual-QA driver).
