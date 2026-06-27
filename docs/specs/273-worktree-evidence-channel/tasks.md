# 273 — tasks

**Verify:** `env -u TMUX npx vitest run test/unit/worktreeEvidence.test.ts test/unit/worktreeVerify.test.ts`
<!-- extend with the persistence + bridge suites as they land -->

## Layer 1 — pure store — DONE (commit `b8510f2`-line)
- [x] 1. `src/worktree/evidence.ts` — `WorktreeEvidence` + `evidenceStale` (HEAD-only), `appendCapped`,
  `replaceVerifySet`, `summarizeEvidence`, `isSafeArtifactRef`. Pure. 10 tests green.

## Layer 2 — persistence — DONE (commit `52f7d9a`)
- [x] 2. **OQ1 resolved by inspecting `SessionLedger`:** its mutations are SYNCHRONOUS read-modify-write (no await),
  and all evidence writes run in the single extension process (the bridge routes MCP calls there) → no lost-write
  race; no jsonl needed. (Codex's "racy array RMW" applies to async/multi-process writers, which this isn't.)
- [x] 3. `WorktreeRecord.evidence?` + synchronous `getEvidence`/`appendEvidence`/`replaceVerifyEvidence` mirroring
  `recordVerify`; defensive parse drops malformed records; `isSafeArtifactRef` traversal guard. Ledger tests +
  concurrent-append (synchronous) no-lost-write test green. (Managed artifact-DIR copy deferred — refs validated,
  durability copy is a follow-up.)

## Layer 3 — built-in producer — DONE (commit `52f7d9a`)
- [x] 4. `Workspace.runVerify`: records one `step-result` per `RunbookJob.step` into `data`, stamped
  `sourceRunId`(=ranAt)+`atCommit`, REPLACING the prior verify set; rollup `VerifyState` unchanged.

## Layer 4 — bridge — DONE (commit `52f7d9a`)
- [x] 5. `attach_evidence` — **producer is self-declared** (the bridge has NO connection-bound identity; every tool
  takes a self-declared `caller`/`agent` — so "host-derived producer" isn't achievable; provenance, not auth, like
  the rest of the bridge). Tachyon stamps id/producedAt/atCommit/schemaVersion; artifact refs traversal-checked.
- [x] 6. `list_evidence(agent)` — fresh/stale-flagged, newest-first.
- [x] 7. Compact MECHANICAL summary folded additively into `verify_agent`/`list_agents` (`VerifyHandoff.evidence`).
- [x] Bridge tool-count test 27→29 updated; full suite green (1663); typecheck+esbuild+engine-boundary clean.

## Layer 5 — UI (NOT STARTED — checkpoint here per owner)
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
