# Tasks 240 — `isolate: transcript`

**Verify:** `cd /home/goat/tachyon && env -u TMUX npx vitest run`
**UI impact:** none

## Increment 1 — config field + validation ✅
- [x] `AgentDef.isolate?: "transcript"` parsed in `loadConfig.ts` (scalar enum) + in AGENT_KEYS.
- [x] Reject: non-claude runtime, terminal, and `env.CLAUDE_CONFIG_DIR` set.
- [x] Tests (5): accepted form; each rejection with a clear error.

## Increment 2 — home-only materialization ✅
- [x] Extracted `materializeHome(agent, adapter, cwd)` from `HarnessManager.materialize()` (private home + symlinked `.credentials.json` + `.claude.json` markers + per-cwd trust); `materialize()` reuses it (full-harness output unchanged).
- [x] `claudeConfigHome` returns the private home for `harness` OR `isolate === "transcript"`; `applyHarness` gate fires for isolate; `materializeHomeOnly` returns `{ env:{CLAUDE_CONFIG_DIR}, args:[] }` (no strict-MCP).

## Increment 3 — drift fix (D4 invariant) + ambiguity bucket ✅
- [x] `SessionResume.configHome?: string` + parse.
- [x] `withConfigHome` stamps + PRESERVES configHome at EVERY resume-write site (spawn / refreshOwnership / injectResumeId / resume / fork — the rewrite sites spread the prior resume first, codex BLOCKER fold); `rehydrateFromLedger` backfills missing configHome once.
- [x] `refreshOwnership` + `transcriptPathOf` ambiguity = `(canonical cwd, effectiveHome)`; lookups use `effectiveHome` (persisted ?? derive).
- [x] `gcHarnessHomes` keep-set = declared ∪ tracked ∪ **path-referenced** (`resume.configHome`) → a renamed agent's live home isn't reaped (codex BLOCKER fold).
- [x] Tests: isolate same-cwd unambiguous + followed + own-home; plain same-cwd still suppressed; pre-240 derive-fallback; rehydrate backfill.

## Increment 4 — lifecycle / GC / worktree compose ✅
- [x] Private home created on spawn/restart/resume; never removed on Stop; reaped via spec-239 delete→`ledger.remove` + `gcHarnessHomes` (path-aware keep-set).
- [x] `worktree + isolate` composes — `claudeConfigHome` is worktree-independent (not auto-enabled).

## Closure
**Closure:** Increments 1–4 shipped. Codex reviewed (debate SPEC-READY → impl BLOCK on 2 real BLOCKERs: configHome dropped on resume/inject rewrites + name-based GC keep-set → both folded → re-confirmed FIXED). 840 unit tests green; tsc + engine-boundary + build clean. EDH validation pending (the user's gate; ships in 0.29.0 with spec-239 inc 6 paging). Known boundary: a pre-240 row whose agent's home changed BEFORE upgrade can't be retro-attributed (spec R1).
