# 218 — tachyon-test-tmux-isolation — tasks

**Verify:** `npm run typecheck && npx vitest run` (safe even with `$TMUX` set to production)

## Implementation

- [x] 1. **Shared guard** `test/helpers/tmuxEnv.ts` — `tmuxChildEnv(base=process.env)` strips
      `TMUX` + `TMUX_PANE` so an unscoped tmux op in a test falls back to the `default` socket,
      never the inherited production `-L tachyon`. Pure + unit-tested (`test/unit/tmuxEnv.test.ts`,
      3 tests: strips both, preserves others, no input mutation).
- [x] 2. **Apply to every real-tmux exec in tests** — `anchor.integration.test.ts`,
      `tmux.real.test.ts` (executor + `-V` probe + scoped `kill-server` teardown + the HOME-override
      executor), `verifyGate.integration.test.ts` (executor + `-V` + teardown). Grep confirms no
      `execFile(Sync)?("tmux"` without `tmuxChildEnv`.
- [x] 3. **Doc** — the guard's contract ("every real-tmux test executor MUST use this env, in
      addition to `-L <isolated socket>`") lives in the `tmuxEnv.ts` docstring.
- [ ] 4. **codex dueto** — optional; the structural proof below is strong empirical validation.

## Validated
- `tmuxEnv` 3/3; full suite **465 tests / 32 files green** run WITH `$TMUX=/tmp/tmux-1000/tachyon,…`
  (no `env -u TMUX`) → **production sessions (claude/claude-3/codex/ctl) all survived** before/after.
  This is the structural version of spec 217's per-call proof. typecheck exit 0.

## Notes
- Test-only; production `TmuxService` always `-L`-scopes and was not touched.
- Pairs with the spec-217 point fix (anchor.integration's `kill-server` now `-L`-scoped). This spec
  is the second layer so a future missed `-L` can't reach production. Root cause + lesson:
  memory `project_tachyon_test_tmux_contamination`.
