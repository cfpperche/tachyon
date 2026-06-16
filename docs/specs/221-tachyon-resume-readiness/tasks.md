# 221 — tachyon-resume-readiness — tasks

**Verify:** `npm run typecheck && npx vitest run` (safe with `$TMUX` set — spec 218 guard)

## Implementation
- [x] 1. **`AgentManager.resumeReadiness(record)`** — read-only pre-flight mirroring `resume()`'s
      id-resolution + transcript-exists, no spawn. qwen→true; claude name→title-resolve; empty→capture;
      then fileExists(transcriptPath) when derivable, else true.
- [x] 2. **Sidebar** — probe each resumable agent (Promise.all, like the verify badge) into
      `resumeReadyOf`; pass `resumeReady?: boolean` to `AgentTreeItem` (undefined when not resumable).
- [x] 3. **`AgentTreeItem`** — `freshOnly = resumable && resumeReady === false` → `· fresh start` +
      tooltip (↻ starts fresh); else `· resumable` as before. `undefined` → unchanged (no regression).
- [x] 4. **l10n** — pt-BR for `fresh start`, the fresh-only tooltip, and the stopped fresh-only tooltip
      (reused the existing resumable strings; reverted an accidental wording change to avoid orphaning).
- [x] 5. **Tests** — `resumeReadiness` branch matrix (uuid present/gone, name→title-resolve, qwen→true,
      no-block→false). 482 unit tests + typecheck + i18n-completeness green.
- [x] 6. **codex dueto** — 2 rounds. round-1: MAJOR (resumeReadiness ignored missing `def.cmd` →
      mirrored resume()'s rejection + test) + MINOR (Sidebar probed running agents → filter to stopped).
      round-2: **SHIP**.
- [x] 7. **Shipped 0.19.0** — build → `vsce publish minor` → push main + tag `v0.19.0`.

## Notes
- The readiness probe must stay in lockstep with `resume()`'s resolution — if they diverge, the badge
  lies. Both now share the same id-resolution shape (qwen / claude-name / capture / transcriptPath).
- Perf: common case (a Stop-captured uuid) is a single stat; only an uncaptured-NAME claude row scans
  the jsonl dir. Same scale as the spec-214 verify badge's per-refresh git reads. Cache later if it bites.
