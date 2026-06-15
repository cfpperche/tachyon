# 220 — tachyon-claude-resume-fix — tasks

**Verify:** `npm run typecheck && npx vitest run` (safe with `$TMUX` set — spec 218 guard)

## Verification (live, claude 2.1.177) — DONE
- [x] V1 round-trip: `claude -n <name> -p` persists; `claude --resume <name> -p` recalls (returns the
      secret). `-n` materializes a `<uuid>.jsonl` transcript (unlike the broken `--session-id`).
- [x] V3: `--resume <missing>` errors (print) / picker (interactive) → never call for a maybe-missing id.
- [x] V2: `--resume <name>` with duplicate customTitles ERRORS → resume by UUID, not by name.
- [x] jsonl header = `{customTitle, sessionId, type}` → unique title → exact uuid, shared-cwd-safe.

## Implementation
- [x] 1. **`adapters.ts`** — claude `nameMint: true`; `injectId` → `-n <name>` (still verbatim when
      `managesOwnSession`, so `--resume evals` agents are untouched); `resumeCommand` `--resume <id>`;
      `transcriptPath` unchanged.
- [x] 2. **`resolvers.ts`** — `resolveClaudeIdByTitle(cwd, title)` scans jsonl first-lines for
      `customTitle === title` → newest matching `sessionId`; `resolveCurrentSession` gains an optional
      `title` (claude uses it; codex/opencode unchanged = newest-by-cwd).
- [x] 3. **AgentManager** — `claudeSessionName(agent)` = `tachyon-<basename(workspaceRoot)>-<agent>`
      (sanitized); spawn name-mints when `adapter.nameMint`; `refreshOwnership` resolves claude by
      title and BYPASSES the cwd-ambiguity gate (unique title disambiguates); other runtimes stay gated.
- [x] 4. **Workspace** — thread `title` through `resolveCurrentSession`.
- [x] 5. **219-followup** — `TmuxService.serverOptionArgs()` (extracted, shared) +
      `hasServer()` + `applyLiveOptions()` (re-assert on a live server, no session, no phantom server);
      `Workspace.applyConfig` calls it best-effort so update/Reload applies clipboard without a restart.
- [x] 6. **Tests** — resume adapter `-n`/nameMint; `resolveClaudeIdByTitle` (newest-wins, shared cwd,
      miss→null); AgentManager name-mint + title-capture + shared-cwd-resolves + codex-still-gated +
      crash→Resume upgrade; tmux `applyLiveOptions` live + no-phantom. **479 pass, typecheck 0.**
- [x] 6b. **Self-review crash-gap fix** — `resume()` ALSO resolves-by-title when the stored id is still
      the bare spawn name, so a CRASHED claude agent (never ran kill()→refreshOwnership) or a Resume
      right after a reload still recovers context instead of falling back to fresh. (+ regression test)
- [x] 7. **Docs** — README session-resume section: `cmd: claude` agents spawn a named session and
      capture the real uuid; resume restores context even with many claude agents in one folder.
- [~] 8. **codex dueto** — two full read-only explorations completed (codex read all 5 changed files +
      tests); the `codex exec` final-message capture failed 3× in this environment (tooling, not a code
      signal). Relied on rigorous self-review (which surfaced + fixed the 6b crash-gap). JSON-stream
      retry in flight.
- [ ] 9. **Ship 0.18.0** — `npm run build` → `npx vsce publish minor` → push main + tag.

## Notes
- Resume by the CAPTURED uuid (dup-proof), spawned via a unique `-n <name>`; the name's `customTitle`
  is the disambiguator that defeats the spec-212 shared-cwd capture ambiguity.
- Migration: a pre-220 ledger row (uuid sessionId, spawned without `-n`) won't match any customTitle →
  refresh keeps the dead uuid → resume fails → existing fresh-spawn fallback; one fresh spawn (now `-n`)
  self-heals it.
