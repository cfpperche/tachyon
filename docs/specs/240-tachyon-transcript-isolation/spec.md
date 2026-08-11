# Spec 240 — `isolate: transcript` (per-agent transcript namespace, same cwd)

**Status:** draft

## Problem

Multiple interactive claude agents that share ONE working directory (no git worktree) write their transcripts into the same `~/.claude/projects/<encoded-cwd>/` bucket. Tachyon then can't attribute a session to an agent, doesn't follow an in-TUI `/resume` or `/clear`, and the durable activity log (spec 239) isn't generated — so it shows "Waiting for activity…" for a working agent (the prefer-gap behavior, which is correct given the ambiguity). Market research (issues anthropics/claude-code#44607, #58933; the 9-orchestrator survey) confirms: interactive claude can't expose/control its own session id, and the real fixes are **isolation per agent** (worktree, already supported) or the SDK. We want the **same-cwd** case to work too, keeping the interactive TUI.

## Goal

A lightweight per-agent toggle that isolates the claude **config HOME** (→ a separate transcript namespace) WITHOUT the `harness:` feature's MCP/skills/rules isolation:

```yaml
agents:
  reviewer:
    cmd: claude
    isolate: transcript
```

The agent still loads the **workspace project config** (`CLAUDE.md`, `.claude/`, `.mcp.json` — these are cwd-relative, unaffected by a home redirect), inherits auth (the harness's existing symlinked `.credentials.json`), and gets its own transcript bucket → attribution + in-TUI session-follow + the activity log all work on a shared folder.

## Decisions (Claude + Codex debate)

- **D1 — `isolate: transcript` is a distinct scalar enum field, NOT a `harness:` mode.** `harness:` carries strict-MCP semantics (it replaces the project `.mcp.json`); overloading it would conflate "capability harness" with "home-only isolation". A scalar enum (not a boolean — `true` is too vague) leaves room for future modes. claude-only in v1; reject on terminals, non-claude runtimes, and when `env.CLAUDE_CONFIG_DIR` is set by the user (Tachyon owns the home).
- **D2 — reuse the home + auth machinery; skip the MCP/capability parts.** Factor the private-home seeding out of `HarnessManager.materialize()` into a home-only helper: create `harnessHome(ws, agent)`, symlink `.credentials.json` from the real home, seed `.claude.json` onboarding/trust markers — and return `args: []` (NO `--mcp-config` / `--strict-mcp-config`). Do NOT seed project `.mcp.json`, rules, skills, hooks, or settings. Result: same auth, isolated transcripts, project config still from cwd.
- **D3 — the ambiguity bucket becomes `(canonical cwd, effective config home)`.** Both predicates (`refreshOwnership` ~L605, `transcriptPathOf` ~L830) compare cwd-only today; they must compare each peer's `(cwd, home)`. Two agents sharing a cwd but with different homes are NOT ambiguous (their transcripts don't mix) → newest-by-cwd within the isolated home safely follows an in-TUI `/resume`/`/clear`. Two PLAIN agents on a shared cwd stay ambiguous → prefer-gap (unchanged).
- **D4 — persist `resume.configHome` on the ledger record (the drift fix), as a hard invariant.** The effective home is derived from TODAY's config (`claudeConfigHome(definitionOf(name))`); the ledger row doesn't record which home a session was written under. Toggling `isolate` or renaming an agent would then make Tachyon look in the wrong home (suppress logs or resume fresh). The invariant (codex HIGH):
  1. **Every ledger write preserves or sets `resume.configHome`** — a write must never silently erase it (a stale/partial write that drops it would re-introduce drift). New rows record the ACTUAL augmentation home used.
  2. **Existing rows are backfilled once** (on load/first touch) with the derived home, so old sessions stop being drift-prone immediately, not only when next written.
  3. **GC treats any persisted `resume.configHome` as LIVE** — `gcHarnessHomes` must never reap a home still referenced by a ledger row's `configHome` (else it deletes a resumable transcript namespace).
  4. Lookup uses `record.resume.configHome ?? claudeConfigHome(name, def)` (persisted wins; derive only as the backfill source).
- **D5 — lifecycle.** Materialize the private home at the same augmentation point as the harness (spawn/restart/resume). NEVER delete on Stop (the transcript is the resumable state). Reap on explicit delete/dismiss (spec 239 already removes the ledger row) + the startup ownerless-home GC (`gcHarnessHomes`, agent neither declared nor ledger-tracked). Storage can keep the existing `.tachyon/harness/<agent>` root (rename comments toward "private claude home").
- **D6 — composable with worktree.** A worktree already gives a unique cwd (isolated), so `isolate: transcript` is usually redundant there — but if declared, honor it (don't auto-enable, don't silently ignore).

## Non-goals
- The `harness:` MCP/skills/rules isolation (that's a different, heavier feature).
- Non-claude runtimes (note the generalization: each runtime's own config-home env; not wired in v1).
- Changing worktree behavior or auto-enabling isolation anywhere.

## Risks
- **R1 — config-home drift** (highest): mitigated by the D4 invariant (preserve/backfill `resume.configHome` on every load+write; GC treats it as live). The single most likely EDH bite is a row without a durable `configHome`, or one overwritten from today's config, drifting after a toggle/rename.
- **R2 — logged-out real home**: the symlink seeding fails → the same honest "run claude /login first" error as harness.
- **R3 — storage-root naming confusion** (`.tachyon/harness/<agent>` now also holds non-harness isolated homes): comment/rename toward "private claude home"; no functional impact.

## Acceptance
- [ ] An `isolate: transcript` agent on a shared cwd generates its own durable activity log (spec 239) and the panel shows it.
- [ ] An in-TUI `/resume` / `/clear` inside that agent IS followed (new session stitched), on a shared cwd.
- [ ] The agent still loads the workspace `CLAUDE.md`, project `.claude/`, and `.mcp.json` (cwd-relative).
- [ ] No re-login when the real home is authenticated (symlinked credentials); a logged-out real home gives the honest error.
- [ ] Two `isolate: transcript` agents in the same folder don't cross-contaminate; two PLAIN agents in the same folder stay prefer-gap-suppressed.
- [ ] `resume.configHome` is persisted + used for lookup; an old row without it still resolves via derivation.
- [ ] Delete/GC reaps the private home; no leak. `worktree + isolate: transcript` composes.
- [ ] Config rejects `isolate` on terminals / non-claude / with a user `env.CLAUDE_CONFIG_DIR`.
