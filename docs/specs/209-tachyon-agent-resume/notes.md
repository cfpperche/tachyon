# 209 — tachyon-agent-resume — notes

## Research (verified 2026-06-11 against the live binaries, not just docs)

Five parallel research passes, each confirmed against the installed CLI where
present. Treat this matrix as load-bearing for the adapters — it was checked end
to end (claude 2.1.173, codex 0.139.0, gemini 0.42.0, opencode 1.17.3).

### claude (Claude Code) — mint
- **Caller-supplied id:** `--session-id <uuid>` (must be valid UUID). Best path —
  mint at spawn, persist, resume by id; robust to a crash before any output.
- **Resume:** `claude --resume <uuid>` / `-r`; `-c`/`--continue` = most-recent in cwd;
  `--resume` (no arg) = TUI picker (not headless). Headless: `claude -p ... --resume <uuid>`.
  `--fork-session` branches instead of appending.
- **Capture (if not minted):** `--output-format json` → top-level `session_id`;
  stream-json events all carry `session_id`. No first-party list command (issue
  #44063 closed/not-implemented); `claude agents --json` lists *background* agents.
- **Storage:** `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, encoded-cwd = abs cwd
  with `/` and `.` → `-` (empirical, not formally documented — prefer minted id +
  own mapping over hard-coding the path). Override root: `CLAUDE_CONFIG_DIR`.
- **Full headless resume:** yes (file-based, decoupled from process). Retention:
  30d default (`cleanupPeriodDays`). Never set `--no-session-persistence` /
  `CLAUDE_CODE_SKIP_PROMPT_HISTORY`. Two writers interleave → single-writer or `--fork`.
  Permissions/MCP re-load on resume (re-pass `--permission-mode`, same `.mcp.json`).
- Sources: code.claude.com/docs/en/{sessions,headless,cli-reference}; gh issue 44063.

### codex (OpenAI Codex) — capture
- **No caller-supplied id** (UUIDv7 minted). 
- **Resume:** TUI `codex resume [<id>|--last|--all|--include-non-interactive]`;
  headless `codex exec resume [--last|<id>] "prompt"`. No `--continue` (use `--last`).
  `codex fork` to branch.
- **Capture:** `codex exec --json` first event `{"type":"thread.started","thread_id":"<uuid>"}`.
  TUI does NOT print the id → discover from disk. (open issue openai/codex#3817.)
- **Storage:** `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`; first line is
  `session_meta` with `cwd` (the cwd↔id map), `cli_version`, `originator`. Also
  `~/.codex/session_index.jsonl` + `state_*.sqlite` (internal). `$CODEX_HOME` overrides.
- **Full headless resume:** yes. NEVER `--ephemeral` (not persisted). cwd must match
  for `--last`/picker (or resume by id / `--all`). Min ~v0.138.0 for clean
  `resume --last "<prompt>"`. Approval/sandbox NOT auto-restored — re-pass `-a`/`-s`.
- Sources: developers.openai.com/codex/{noninteractive,cli/reference,cli/features,changelog}; gh issue 3817.

### gemini (Google Gemini CLI) — mint (proven live)
- **Caller-supplied id:** `--session-id <UUID>` (start new with given id; reusing
  errors → "use --resume"). `--list-sessions`, `--delete-session <index>`.
- **Resume:** `-r/--resume <uuid|latest|index>`; verified headless context recall
  (`--resume <id> -p`). Resume by UUID or `latest`, NOT index (indexes shift).
- **Capture (if not minted):** `-o json`/`stream-json` first event `init` with
  `session_id` (snake_case; on-disk file uses `sessionId`). Since PR #14504 (Dec 2025).
- **Storage:** `~/.gemini/tmp/<project_key>/chats/session-<ts>-<idprefix>.jsonl`;
  `<project_key>` cwd-derived (friendly-name dir + `.project_root` = abs cwd, or legacy
  64-hex SHA). Project-scoped → respawn same cwd.
- **Full headless resume:** yes (proven). Min ≥0.16 (resume), PR#14504 (json id).
  **Trusted-folder gate:** untrusted folder refuses headless → pass `--skip-trust` or
  `GEMINI_CLI_TRUST_WORKSPACE=true`. Retention: 30d / 50 sessions default.
- Sources: geminicli.com/docs/cli/{session-management,headless,trusted-folders}; gh 14435/PR14504.

### opencode (SST) — capture
- **No caller-supplied id** (`ses_...` minted).
- **Resume:** `opencode -c`/`--continue` (last for cwd), `-s <id>`/`--session`,
  `--fork`. Headless: `opencode run "<msg>" -s <id>` / `-c`. `opencode session list`.
- **Capture:** `opencode run --format json` first event `step_start` carries
  `sessionID`; or `session list --format json` (cwd-sensitive — bit the researcher,
  don't trust empty); or the server API (`GET/POST /session`).
- **Storage:** `~/.local/share/opencode/storage/{project,session,message,part}/`;
  `project/<projectHash>.json` maps `worktree`(cwd)→hash; `session/<hash>/ses_*.json`.
  No project-local `.opencode/`. XDG-relocatable.
- **Full headless resume:** yes (`run -s <id>`). Client/server: `opencode serve`
  daemon survives client crash but dies on reboot (storage outlives it). Resumed
  sessions drop orphaned interrupted tools (safe). Confirm `--fork`/json on pinned ver.
- Sources: opencode.ai/docs/{cli,server,sdk}; github.com/sst/opencode (v1.17.3).

### qwen (Qwen Code) — capture (best of the "others")
- Resume: `qwen --resume <uuid> -p` / `--continue -p`; `--resume` (no id) = picker.
  Sessions **stored in the working dir** (inherently cwd-scoped). Restores history +
  tool outputs + compression checkpoints. No caller id. Sources: github.com/QwenLM/qwen-code issues 688/1270/3606.

### continue (`cn`) — capture
- Resume: `cn -p "..." --resume "<session_id>"`; capture via `-p --output-format json`
  → `.session_id` (documented `jq` pattern). `cn ls` / `cn --resume` picker. Headless
  full-context resume documented. cwd-keying not documented (persist the id). Source: docs.continue.dev/{guides/cli,cli/overview}.

### Tier-2 / not v1
- **goose:** caller-supplied **name** `-n <name>` (rare, nice), but full resume is
  `goose session --resume -n <name>` (interactive); `goose run` headless has no
  documented `--resume`. Global SQLite, not cwd-keyed. Revisit if demand.
- **amp / cursor-agent:** cloud-backed threads; survive reboot trivially but need
  auth + externally-persisted thread id; no local cwd mapping. Best-effort later.
- **No real resume:** aider (single replayed `.aider.chat.history.md`, no sessions),
  crush (`run` starts fresh — resume is interactive-only), cline (no resume-by-id).

## Common patterns the adapter design leans on
1. Two id strategies: **mint** (claude/gemini/goose) vs **capture** (codex/opencode/qwen/continue/cursor/cline).
2. **cwd is the universal key** — every transcript is scoped to the working dir;
   Tachyon's per-workspace spawn already provides a stable cwd.
3. JSON-first-event is the common capture handle (`session_id`/`thread_id`/`sessionID`).
4. **"interactive resume vs headless run" trap** — some tools (goose/crush) only
   resume in the interactive command; check before wiring.
5. Permissions/sandbox/MCP are **never auto-restored** on resume → re-pass from ledger.
6. Retention windows + `--ephemeral`-style no-persist flags can make a session
   unrecoverable → always degrade to fresh spawn.

## Why NOT boot survival (the rejected path)
The tmux-sentinel demo (the user's learning project) solved "survive `wsl --shutdown`"
by installing tmux-resurrect+continuum+TPM globally + a systemd boot unit + a
post-restore `resume-agents.sh`. That global footprint hijacked Tachyon's dedicated
socket (continuum auto-restoring our sessions) and was removed + isolated against in
v0.9.2 (`-f /dev/null`). This spec deliberately does NOT reintroduce any of it:
resume is in-process, per-workspace, triggered by reopening the workspace in VS Code.
Headless-without-VS-Code survival is out of scope by design, not omission.
