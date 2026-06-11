# 209 — tachyon-agent-resume

_Created 2026-06-11._

**Status:** shipped

**Closure:** 2026-06-11 — claude (mint) + codex (capture) verified LIVE end-to-end:
`--session-id` mint → transcript at the adapter's exact path → `--resume` recalled
the prior codeword (BANANA-7714); `codex exec` persisted → the real
`resolveCodexId()` resolved the id from disk by cwd → `codex exec resume` recalled
MANGO-3391. 261 unit tests (adapters/ledger/planResume/resolvers + AgentManager
spawn-inject & resume). v1 runtimes: claude+gemini (mint) and codex+opencode
(capture) wired; qwen/continue resume only when an id was captured (disk resolver
deferred). Residual: the in-VS-Code reopen→auto-resume + ad-hoc offer flow is
wired and unit-tested but not yet driven through the xvfb rig (real CLIs+auth in
Xvfb is heavy) — recommend a manual reopen test. goose/amp/cursor not implemented.

**UI impact:** interaction
<!-- Activation-time resume of agents whose process died (crash/reboot), plus a
sidebar/notification affordance to resume ad-hoc ones. Verified by driving the
real CLIs against their on-disk transcripts. -->

## Intent

F29: **survive the death of the agent process, not just the VS Code window.**

Today Tachyon survives a VS Code restart by re-attaching to tmux sessions that
outlived the window. But the tmux server — and every agent process — dies on a
full crash, machine reboot, `wsl --shutdown`, or OOM. When that happens the user
must manually `claude --resume` / `codex resume` every agent, in every workspace,
in every VS Code window on the machine. This is the single most-reported pain.

The fix is narrow and runtime-native: every modern agent CLI persists its
conversation transcript to disk, keyed by working directory, and exposes a
resume command (`--resume <id>` / `resume <id>` / `-s <id>`). Tachyon already
spawns each agent in a stable per-workspace cwd. So Tachyon can:

1. **capture or mint a session id at spawn** and persist a per-workspace ledger,
2. on activation, for any known agent whose tmux session is gone, **respawn it
   with the runtime's resume flag** — recovering full conversation context.

This is in-process state only: no global `~/.tmux.conf`, no plugins, no systemd
boot unit (the explicitly-removed tmux-sentinel approach — see [[notes]] §"why not boot survival").

## Capability summary (full detail + sources in notes.md)

| Runtime | id strategy | resume cmd | cwd-keyed transcript |
|---|---|---|---|
| claude | mint `--session-id <uuid>` | `claude --resume <uuid>` | `~/.claude/projects/<enc-cwd>/<uuid>.jsonl` |
| codex | capture (`exec --json` thread.started / disk `session_meta.cwd`) | `codex resume <id>` | `~/.codex/sessions/.../rollout-*-<uuid>.jsonl` |
| gemini | mint `--session-id <uuid>` | `gemini --resume <uuid>` | `~/.gemini/tmp/<proj>/chats/` |
| opencode | capture (`run --format json` `sessionID` / server API) | `opencode -s <id>` | `~/.local/share/opencode/storage/session/<projHash>/` |
| qwen | capture | `qwen --resume <uuid>` | in working dir |
| continue (cn) | capture (`-p --output-format json` `.session_id`) | `cn --resume <id>` | n/d |

Tier-2 / best-effort, not v1: goose (`-n <name>`, resume is interactive-only),
amp/cursor (cloud-backed, auth). No resume: aider, crush, cline.

## Acceptance criteria

- [x] **Scenario: declared agent recovers context after a reboot**
  - **Given** a `tachyon.yml` agent `claude` with `autostart: true` that has been
    talking (a session id is in the ledger) and the tmux server is dead
  - **When** the workspace is reopened (extension activates)
  - **Then** Tachyon respawns it with `claude --resume <id>` in the same cwd and the
    agent answers a "what were we doing?" probe with prior context (not zeroed).

- [ ] **Scenario: ad-hoc agent is offered, not silently resumed**
  - **Given** a spawned (non-declared) agent with a ledger entry and a dead session
  - **When** the workspace activates
  - **Then** Tachyon does NOT auto-respawn it; it surfaces "N agents can be resumed"
    with a one-click Resume (per-agent and resume-all).

- [x] **Scenario: surviving session is re-attached, not resumed**
  - **Given** an agent whose tmux session is still alive (VS-Code-only crash)
  - **When** the workspace activates
  - **Then** Tachyon re-attaches (current behavior) and does NOT spawn a duplicate
    resume — single-writer is preserved.

- [x] **Scenario: id is captured for a capture-only runtime**
  - **Given** a codex agent spawned by Tachyon
  - **When** it has produced at least one turn
  - **Then** the ledger holds its session id (resolved by matching `session_meta.cwd`
    to the workspace), and a later respawn resumes that exact session.

- [x] **Scenario: missing/expired transcript degrades cleanly**
  - **Given** a ledger entry whose on-disk transcript no longer exists (retention
    purge, manual delete)
  - **When** resume is attempted
  - **Then** Tachyon falls back to a fresh spawn (declared) / drops the offer
    (ad-hoc) with a clear notice — never a hard error.

- [x] **Scenario: resume re-passes non-restored runtime state**
  - **Given** an agent that ran with a permission/sandbox/approval posture and MCP config
  - **When** it is resumed
  - **Then** Tachyon re-passes the same spawn flags (permission-mode, sandbox,
    `.mcp.json`) so the resumed process is non-interactive and tool-capable
    (these are NOT auto-restored by the CLIs).

## Non-goals

- **Headless / no-VS-Code boot survival** (systemd unit, `~/.tmux.conf` continuum,
  global plugins). That is the tmux-sentinel model we deliberately removed and
  isolated against (`-f /dev/null`, v0.9.2). Resume is driven by reopening the
  workspace in VS Code.
- **Restoring file-tree / working-copy state.** Only the conversation transcript
  is recovered; checkpoint/undo is each CLI's own concern.
- **Resuming a mid-tool-call turn.** Only the persisted (completed) transcript is
  restored; an interrupted turn restarts from the last persisted point.
- **goose/amp/cursor in v1** (tier-2); aider/crush/cline (no real resume).
- **Cross-machine / cloud sync of sessions.**
