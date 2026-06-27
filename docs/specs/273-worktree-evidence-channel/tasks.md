# 273 — tasks

**Verify:** `env -u TMUX npx vitest run test/unit/worktreeEvidence.test.ts test/unit/worktreeVerify.test.ts`
<!-- extend with the persistence + bridge suites as they land -->

## Layer 1 — pure store
- [ ] 1. `src/worktree/evidence.ts` — `WorktreeEvidence` type + `evidenceStale` (HEAD-only), `applyCaps`
  (≤100/agent; replace verify set by `verifyRunId`), `summarize` (mechanical). Pure. + `worktreeEvidence.test.ts`.

## Layer 2 — persistence
- [ ] 2. Inspect the ledger write path (OQ1); choose atomic-host-append vs sibling jsonl.
- [ ] 3. Persistence impl: concurrency-safe append/replace; managed artifact dir `.tachyon/evidence/<agent>/`;
  path-traversal-rejecting + missing-aware ref resolver. + tests (incl. a concurrent-append no-lost-write test).

## Layer 3 — built-in producer
- [ ] 4. `Workspace.runVerify`: after `runSteps`, record one `step-result` per `StepResult` into `data`, stamped
  `verifyRunId`+`atCommit`, REPLACING the prior verify set; rollup `VerifyState` unchanged. + test.

## Layer 4 — bridge
- [ ] 5. `attach_evidence` — derived `producer` (reject client-supplied), persist. + test (anti-forgery).
- [ ] 6. `list_evidence(agent)` — fresh/stale-flagged records. + test.
- [ ] 7. Fold a compact mechanical summary into `verify_agent`/`list_agents` (additive). + test.

## Layer 5 — UI
- [ ] 8. Evidence count + stale indicator on the worktree agent badge (hover); optional latest summary. Logic in a
  pure/testable module (logic-in-vscode-layer escapes CI).

## Integration / proof
- [ ] I1. Dogfood: run a multi-step verify → per-step evidence visible via `list_evidence`/`verify_agent`; attach a
  `judgment` + artifact via `attach_evidence`; HEAD-move stales it; caps hold.
- [ ] I2. Final codex dueto on the built channel; fold.

## Verification
- [ ] format neutral, never gates (AC1); derived producer (AC2); per-step deduped (AC3); concurrent-append safe
  (AC4); HEAD-only staleness (AC5); artifact traversal-rejected + missing-aware (AC6); bounded (AC7); mechanical
  summary (AC8); no governance (AC9).
