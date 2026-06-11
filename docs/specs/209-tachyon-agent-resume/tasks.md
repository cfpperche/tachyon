# 209 — tachyon-agent-resume — tasks

## Implementation

- [ ] 1. `src/resume/adapters.ts` — `SessionAdapter` interface + pure adapters for
      claude, codex, gemini, opencode, qwen, continue (mint vs capture, `spawnArgs`,
      `resumeArgs`, `transcriptPath`, cwd→id resolution rules). TDD: unit-test each
      adapter's arg construction + cwd-encoding from a fixture, no real CLI.
- [ ] 2. `src/resume/SessionLedger.ts` — load/save/merge `.tachyon/sessions.json`
      (`agentName -> {runtime, sessionId, cwd, spawnFlags, lastSeen}`); tolerant of
      missing/corrupt file. Pure; unit-tested.
- [ ] 3. Spawn wiring (`AgentManager`/`Workspace`): on spawn, pick the adapter; if
      `mintsId`, inject `--session-id` and write the ledger entry up front; record
      `spawnFlags`. Capture runtimes: resolve+persist the id on first activity tick.
- [ ] 4. Activation resume (`Workspace` activate): classify each ledger agent
      (alive→re-attach / dead+declared+autostart→auto-resume / dead+other→offer);
      respawn via `resumeArgs` in the same cwd, re-passing `spawnFlags`; fall back to
      fresh spawn when the transcript is absent.
- [ ] 5. UX: `tachyon.resumeAgent` + `tachyon.resumeAll` commands, a sidebar
      affordance + notification ("N agents can be resumed"), palette "Tachyon: Resume
      agents". nls (en + pt-br). Per-agent ↻ resume on a dead/declared item.
- [ ] 6. Capture-runtime id resolvers (real-CLI-shaped): codex `session_meta.cwd`,
      opencode `storage/project` worktree→`ses_*`, qwen in-cwd, continue JSON. Pure
      parsers over fixture files; unit-tested.
- [ ] 7. Per-runtime real-CLI smoke tests (skipped when the binary is absent, like
      `tmux.real.test.ts`): spawn → kill → resume → assert prior-context recall, for
      whichever of claude/codex/gemini/opencode/qwen/continue are installed.

## Verification

**Verify:** `npm run typecheck && npm test`

- Unit: adapters (arg/path/cwd-encoding), ledger (merge/corruption), id resolvers
  (fixture parse), activation classifier (alive/dead/declared/ad-hoc/missing).
- Real-CLI smoke (local, binary-gated): resume recalls prior turn.
- xvfb visual: reopen-after-`tmux kill-server` auto-resumes a declared agent and
  offers an ad-hoc one (drive via the screenshot/integration rig).

## Notes

- See `notes.md` for the verified per-runtime research + sources (the matrix is
  load-bearing for the adapters — don't re-derive, it was confirmed against the
  live binaries 2026-06-11).
- Keep adapters table-driven and small; the drift risk lives in the real-CLI
  smoke tests, not in clever runtime detection.
- Closure must record: which runtimes were smoke-tested live vs adapter-only,
  unit count, and the xvfb reopen-resume evidence.
