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

## Open
OQ1-5 resolved in spec.md. Build per plan.md sequencing (L1 pure → L5 UI).
