# Tasks 240 — `isolate: transcript`

**Verify:** `cd /home/goat/tachyon && env -u TMUX npx vitest run`
**UI impact:** none

## Increment 1 — config field + validation
- [ ] `AgentDef.isolate?: "transcript"` parsed in `loadConfig.ts` (scalar enum).
- [ ] Reject: non-claude runtime, terminal, and `env.CLAUDE_CONFIG_DIR` set; note redundancy with `harness:`.
- [ ] Tests: accepted form; each rejection with a clear error.

## Increment 2 — home-only materialization
- [ ] Extract `materializeHome(agent)` from `HarnessManager.materialize()` (private home + symlinked `.credentials.json` + `.claude.json` markers + per-cwd trust); `materialize()` reuses it.
- [ ] `claudeConfigHome` returns the private home for `harness` OR `isolate === "transcript"`.
- [ ] Spawn/restart/resume inject `CLAUDE_CONFIG_DIR=<home>` with `args: []` (NO mcp/strict flags) for the isolate case.
- [ ] Tests: env set + auth symlinked + NO mcp args; logged-out real home → honest error. **Harness regression guard**: `materialize()` output (env + args + seeding) for a full `harness:` agent is byte-identical to before the refactor.
- [ ] (Note: same-cwd logging is NOT correct until inc 3 — don't expect the panel to fill after inc 2 alone.)

## Increment 3 — drift fix (D4 invariant) + ambiguity bucket
- [ ] `SessionResume.configHome?: string`.
- [ ] Invariant: EVERY `ledger.record` site preserves/sets `configHome` (never drops it); new rows write the actual augmentation home; missing `configHome` is backfilled once on load via derivation.
- [ ] `refreshOwnership` + `transcriptPathOf` ambiguity = `(canonical cwd, effective config home)` across peers; lookup uses `resume.configHome ?? derive`.
- [ ] `gcHarnessHomes` keep-set includes any `resume.configHome` referenced by a ledger row (never reap a referenced home).
- [ ] Tests: isolated+isolated same cwd → unambiguous (in-TUI `/resume` followed); plain+plain same cwd → still suppressed; old row w/o configHome → backfilled + resolves; a stale/partial write does NOT drop configHome; GC does NOT reap a home a row points at; isolated session attributed → spec-239 log generated.

## Increment 4 — lifecycle / GC / worktree compose
- [ ] Private home created on spawn/restart/resume; never removed on Stop; reaped on delete (ledger.remove) + `gcHarnessHomes`.
- [ ] `worktree + isolate: transcript` composes (honored, not auto-enabled).
- [ ] Tests: GC reaps an ownerless isolate home; worktree+isolate.

## Closure
**Closure:** _(filled at ship)_
