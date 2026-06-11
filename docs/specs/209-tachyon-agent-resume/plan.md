# 209 — tachyon-agent-resume — plan

## Architecture

Three pieces, all in-process / per-workspace. No global config.

### 1. `SessionAdapter` per runtime (`src/resume/adapters.ts`)

Mirrors the existing registration-adapter pattern (`src/registration/adapters.ts`).
Pure, table-driven, unit-testable. One adapter per runtime, selected by the
agent's resolved CLI (reuse the CLI-detection / `inferKind` plumbing).

```ts
interface SessionAdapter {
  runtime: RuntimeId;                       // "claude" | "codex" | "gemini" | "opencode" | "qwen" | "continue"
  matches(cmd: string): boolean;            // does this agent's command use this runtime?
  // ID at spawn:
  mintsId: boolean;                         // claude/gemini: we generate a UUID and inject it
  spawnArgs(cmd: string, id: string): string;   // inject --session-id <id> (mint) OR passthrough (capture)
  // ID capture (capture runtimes): resolve the session id for a (cwd) after the fact
  captureId(cwd: string): Promise<string | null>;  // read newest transcript whose recorded cwd === cwd
  // Resume:
  resumeArgs(cmd: string, id: string): string;     // build the resume command line
  transcriptPath(cwd: string, id: string): string; // for existence/retention checks
}
```

- **Mint runtimes (claude, gemini):** generate a UUIDv4 at spawn, rewrite the
  command to add `--session-id <uuid>`, write the ledger entry immediately
  (robust to a crash before any output). Resume = `--resume <uuid>`.
- **Capture runtimes (codex, opencode, qwen, continue):** spawn unchanged; resolve
  the id lazily by scanning the runtime's on-disk session store for the newest
  entry whose recorded cwd matches this agent's cwd (codex `session_meta.cwd`,
  opencode `storage/project/<hash>` worktree, gemini-style `.project_root`, qwen
  in-cwd, continue via JSON when a headless turn runs). Persist on first resolve.
- All resume paths re-spawn in the **identical cwd** (already how Tachyon spawns).

### 2. Session ledger (`src/resume/SessionLedger.ts` + `.tachyon/sessions.json`)

Per-workspace, append/update map: `agentName -> { runtime, sessionId, cwd, spawnFlags, lastSeen }`.
- Written at spawn (mint) or first id-resolve (capture), updated on each activity tick.
- `spawnFlags` records the permission-mode / sandbox / approval / mcp-config the
  agent ran with, so resume re-passes them (the CLIs do NOT auto-restore these).
- Lives under the existing `.tachyon/` dir (gitignored), like pins/proposals.
- Pure load/save + merge; unit-tested. Tolerates a missing/corrupt file (treat as empty).

### 3. Resume-on-activation (`Workspace` + `AgentManager`)

Extends the existing activation path (`autostartPending`) without changing the
re-attach behavior:

- On activate, for each ledger agent: classify
  - **session alive** → re-attach (today's behavior; no resume, no dup) — single-writer.
  - **session dead + declared + autostart** → respawn via `resumeArgs` (auto). If the
    transcript is gone → fresh spawn + notice.
  - **session dead + ad-hoc OR declared-without-autostart** → collect into a
    "resumable" set surfaced as a notification + a sidebar affordance
    ("N agents can be resumed — Resume all" / per-item ↻ resume).
- A `tachyon.resumeAgent` / `tachyon.resumeAll` command backs the affordance and a
  palette entry "Tachyon: Resume agents".
- Cross-window/workspace: each window resumes its own folders on activation. A
  machine-wide sweep can reuse the F27 inspector's whole-socket view later
  (noted, not v1).

## Alternatives considered

### Piggyback on tmux-resurrect/continuum (the tmux-sentinel approach)
Rejected. Requires global `~/.tmux.conf` + plugins + a boot unit/sudo — exactly
the coupling we removed and isolated against in v0.9.2. Off-identity (headless
fleet without VS Code) and high blast radius. Resume-on-reopen gives ~all the
value for the VS-Code-centric product with zero global footprint.

### Stdout-scrape the session id for every runtime
Rejected as the primary path for mint-capable runtimes: a crash before the first
JSON line loses the id. Minting (`--session-id`) means the id is known before the
process emits anything. Use capture only where the CLI won't accept a caller id.

### Snapshot full pane content (resurrect-style) instead of CLI resume
Rejected. Pane text isn't a resumable conversation — the CLI's own transcript is
the source of truth and `--resume` replays it with full fidelity (proven live).

## Risks

- **Wrong-session resume** when multiple agents share a cwd and we rely on
  "newest". Mitigation: prefer minted ids; for capture runtimes, persist the
  resolved id on first sight and bind it to the agent name, never re-resolve by
  "newest" once known.
- **Double-writer** (resuming while the original still lives). Mitigation: the
  alive/dead classification gates resume on "no live tmux session"; optionally
  `--fork` as a safety valve.
- **Silent context loss** if a CLI changes its on-disk format/flags. Mitigation:
  adapters are small + table-driven; a real-CLI smoke test per runtime (skipped
  when the binary is absent) catches drift, like `tmux.real.test.ts`.
- **Retention purge** (claude/gemini ~30d): resume must degrade to fresh spawn.
- **Permission re-prompt on unattended resume.** Mitigation: re-pass the recorded
  non-interactive permission/sandbox flags from the ledger.
