# 220 — tachyon-claude-resume-fix

_Created 2026-06-15._

**Status:** SHIPPED v0.18.0 (2026-06-15, commit `7e90eb3`). Live-verified design (V1/V2/V3 + customTitle),
implemented, codex dueto (2 rounds: 5+2 findings, all fixed/accepted), 481 tests + typecheck green.
**Closure:** named-session + customTitle-capture + resume-by-uuid landed; 219-followup bundled; pending
maintainer dogfood confirmation on the live install.

**Verify:** `npm run typecheck && npx vitest run` (safe with `$TMUX` set — spec 218 guard)

**UI impact:** none (changes the spawn/resume commands; "Resume with context" starts behaving).

## Intent

**Fix "Resume with context" failing `transcript no longer on disk` for a plain `cmd: claude` agent**
(dogfood pin `p-b5801a`). Stop an agent, click ↻ Resume → error, comes back contextless.

## Root cause (verified live, claude 2.1.177)
1. **uuid-mint is broken against current claude.** For `cmd: claude`, Tachyon mints a uuid, spawns
   `claude --session-id <uuid>`, records it, resumes via `claude --resume <uuid>` after checking
   `~/.claude/projects/<encodeClaudeCwd(cwd)>/<uuid>.jsonl`. Proven across 3 isolated-tmux tests (real
   conversation, even clean Ctrl-C exit): **claude never materializes a transcript under the minted
   uuid** → the existence check always fails → resume errors. Runtime drift vs spec 209's assumption.
2. **The spec-212 capture fallback can't recover it here** — `resolveCurrentSession` (newest jsonl by
   cwd) is ambiguity-gated; multiple claude agents share `/home/goat/Agent0` → skipped.

## Authoritative claude CLI semantics (docs, verified)
- `-n, --name <name>`: "Set a display name for the session... **You can resume a named session with
  `claude --resume <name>`**."
- `-r, --resume`: "Resume a specific session **by ID or name**, or show an interactive picker...
  passing a session ID searches the current project directory **and its git worktrees**."
- `--session-id`: "Use a specific session ID (must be a valid UUID)" — but empirically does NOT yield
  a resumable transcript for a fresh uuid in 2.1.177.

## Confirmed approach (superseded in detail by "Implementation design" below)
The user's own working agents (`claude --resume tachyon`/`evals`/`visual`) prove named resume works.
Initial idea was resume-by-NAME, but V2 showed `--resume <name>` errors on duplicate titles, so the
verified design spawns with a deterministic name `tachyon-<workspace>-<agent>` (the `tachyon-` prefix
avoids colliding with the user's manual sessions; the workspace keeps it unique per cwd) but then
**captures the real uuid via the jsonl `customTitle` and resumes by uuid** (dup-proof). The unique
name is what disambiguates the shared-cwd problem that defeated the spec-212 capture.

## Verification (live, claude 2.1.177) — DONE (deterministic print-mode tests)
- **V1 — round-trip WORKS:** `claude -n <name> -p "remember 8317XQ"` persists a session; `claude
  --resume <name> -p "what secret?"` → **"8317XQ"**. AND `-n <name>` **materializes a transcript**
  (`<claude-uuid>.jsonl`) — unlike the broken `--session-id` mint. ✓
- **V3 — `--resume <missing>` ERRORS** (print) / PICKER (interactive). Never call it for a name/id
  that may not exist in a non-interactive spawn.
- **V2 — `--resume <name>` with DUPLICATE customTitles ERRORS** (`"matches 2 sessions ... pass a
  session ID to disambiguate"`). So resume-by-**name** is fragile under repeated ▶-fresh (each makes
  another session with the same title). → **Resume by the real UUID, not by name.**
- **KEY — the jsonl header carries the title:** first line = `{customTitle, sessionId, type}`,
  `customTitle === <our name>`, `sessionId === <claude's real uuid>`. So a UNIQUE per-agent name lets
  us look up the exact uuid **unambiguously even when many claude agents share one cwd** — the precise
  thing that defeated the spec-212 newest-by-cwd capture (its ambiguity gate).

## Implementation design (verified, blueprint)
Switch claude from **uuid-mint** to **name-spawn + customTitle-capture + resume-by-uuid**:
1. **`adapters.ts`** — claude gains `nameMint: true`; `injectId(cmd, id)` → `-n <id>` (id = the name,
   still skipped when `managesOwnSession`, so the user's `--resume evals` agents are untouched);
   `resumeCommand` stays `--resume <id>` (id is the captured uuid, or the name as fallback);
   `transcriptPath` unchanged (`<id>.jsonl` — passes once id is the captured uuid).
2. **AgentManager.spawn** — when `adapter.nameMint`, the minted id is the deterministic NAME
   `tachyon-<basename(workspaceRoot)>-<agent>` (sanitized) instead of a random uuid; inject `-n
   <name>`; record `resume.sessionId = <name>` (works as a `--resume <name>` fallback before capture).
3. **`resolvers.ts`** — add `resolveClaudeIdByTitle(cwd, title)`: scan
   `~/.claude/projects/<enc(cwd)>/*.jsonl`, parse each first-line `{customTitle, sessionId}`, return
   the (newest) sessionId whose `customTitle === title`. Thread an optional `title` through
   `resolveCurrentSession` (claude uses it; codex/opencode unchanged = newest-by-cwd).
4. **AgentManager.refreshOwnership** (runs in `kill()`, i.e. at Stop, before Resume) — for claude,
   recompute the name and resolve the uuid by `customTitle` (NOT newest-by-cwd), and **bypass the
   cwd-ambiguity gate** (the unique title is the disambiguator). Upgrades `resume.sessionId` from the
   name to the real uuid; the existing transcript-exists guard confirms the uuid's jsonl before
   recording. So by Resume time the ledger holds the dup-proof uuid.
5. **resume()** — unchanged shape: `--resume <sessionId>` (now a uuid) + transcript check passes. A
   genuinely-gone session (capture found nothing → still the name → `<name>.jsonl` absent) →
   `ResumeUnavailableError` → existing fresh-spawn fallback. No picker hang, no wrong context.
- No SessionLedger schema change (sessionId stays a string: name→uuid). gemini keeps uuid-mint;
  codex/opencode/qwen capture unchanged.

## Runtime-agnostic (per the adapter abstraction)
- **claude → named sessions** (this spec).
- **gemini** (the other `mintsId` runtime) — verify whether it has an equivalent named-resume; else
  keep its current behavior + document the gap (don't assume claude's fix applies).
- **codex / opencode / qwen** — already CAPTURE the on-disk id (works); unchanged.

## Bundled: 219-followup (apply clipboard/server-options on config-apply when the server is alive)
Separate small fix shipping in the same release: spec 219's clean-clipboard wiring (and the existing
server options) only (re)assert on `newSession`, so **update-to-0.17.0 + Reload with re-attached
agents doesn't apply it** until an agent is restarted (the maintainer hit this). Fix: in
`Workspace.applyConfig`, when the dedicated server is already alive, apply the server options +
clipboard wiring immediately (idempotent), not only on the next spawn.

## Acceptance
- A plain `cmd: claude` agent: spawn → converse → stop → ↻ Resume → **comes back WITH context**
  (live-verified on the maintainer's setup, multiple claude agents in one cwd).
- No `transcript no longer on disk` for the named strategy; a genuinely-missing session degrades to a
  fresh spawn, never a hard error / picker hang.
- Adapter unit tests: claude `injectId`→`-n <name>`, `resumeCommand`→`--resume <name>`, name builder
  `tachyon-<ws>-<agent>`; no transcript-path check on the claude resume path. codex/opencode/qwen
  capture paths unchanged (regression-tested).
- 219-followup: changing config / reload with a live server applies the clipboard wiring without a
  restart (TmuxService live-apply unit-tested; manual confirm on WSL).
- README/docs: note that `cmd: claude` agents now use named sessions; codex dueto → SHIP; ship 0.18.0.
