# 217 — tachyon-wedge-watchdog — tasks

**Verify:** `npm run typecheck && npm test`

## Implementation

- [x] 1. **Pure reducer** (`src/tmux/wedgeWatchdog.ts` + `test/unit/wedgeWatchdog.test.ts`):
      `WatchdogState` + `watchdogStep` (idle→armed→latched, two-tick confirm, reset on
      healthy/no-server). 6 tests incl. arm-then-clear (no false recover), re-wedge-after-reset,
      no-server-between-wedges resets.
- [x] 2. **Diagnostics snapshot** (`TmuxService.snapshotServerPids`): `ps -o pid,%cpu,rss,etime,stat,cmd`
      of the wedged PIDs, best-effort → "" on empty/failure. Unit-tested (arg pass-through + error→"").
- [x] 3. **Driver wiring** (`extension.ts`): one global 30s interval → `probeServer` → `watchdogStep`;
      on `recover` `console.warn`s the `ps` snapshot, `recoverWedgedServer`, `notify`s the
      auto-recovery message. `clearInterval` registered in `context.subscriptions`.
- [x] 4. **i18n**: the auto-recovered `l10n.t` string + pt-BR bundle entry.
- [x] 5. **Docs**: README "Wedge watchdog" subsection under the tmux Server Inspector. (No
      CHANGELOG.md in the repo — `vsce publish` derives from git history.)
- [x] 6. **codex dueto** — DONE 2026-06-15 (3 rounds): r1 NO-SHIP (MAJOR probe-error preserved the
      armed state; MINOR double "Tachyon:" prefix) → fixed (added `"unknown"` probe state to the
      reducer; dropped the prefix); r2 NO-SHIP (MAJOR setInterval overlap → out-of-order observations
      could fake the two-tick confirm) → fixed (self-rescheduling setTimeout + disposed flag); r3
      **SHIP** (no findings). The earlier "box OOM" worry was the spec-217 test contamination bug, not
      memory — see spec 218 / memory `project_tachyon_test_tmux_contamination`.

## Validated so far (frugal — box was OOM-constrained)
- `wedgeWatchdog.test.ts` 6/6 + `tmux.test.ts` 35/35 green; `tsc --noEmit` exit 0 (run with
  `--max-old-space-size=1536` — capping the heap stops tsc OOMing on this loaded box).
- NOT yet run: the full `npm test` (real-tmux integration suites are heavy) — pending the codex
  dueto session when the box is free.

## Notes
- Decisions D-A (blind periodic probe) + D-B (auto-recover + notify, two-tick confirm) locked
  2026-06-14 (see spec.md). Reuses probeServer + recoverWedgedServer unchanged.
- The wedge ITSELF is upstream (tmux 3.6a/WSL2) — out of scope; this only closes the
  detect-during-a-live-session gap. Diagnostics snapshot exists to root-cause the tmux side later.
- **Tooling gotcha (this box):** the dev box runs supabase/logflare/realtime + multiple VS Code
  hosts + 3 claude agents → heavy Node tooling OOMs (`tsc`/full `npm test` got SIGKILL'd, exit 137).
  Run targeted `vitest <files>` + `tsc` with a capped heap; avoid repeated full real-tmux suites.
