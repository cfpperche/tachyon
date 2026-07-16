# 389 — notes

## Implementation

- Worktree: `/home/goat/tachyon-worktrees/agent-restart-modes` on branch `grok/agent-restart-modes`.
- Core: `AgentManager.restart(name, opts?)` → matrix `stop × session`; body of pre-389 path is private `restartFresh`.
- Graceful timeout uses `STOPPING_FALLBACK_MS` (15s) by default; force-fallback is **session-only** `tmux.killSession` (never `AgentManager.kill`, which wipes ad-hoc).
- Crash auto-restart + file-watch + crash toast one-click → explicit `{ stop: "force", session: "new" }`.
- Bridge + UI product default: graceful + resume.
- UI: QuickPick four modes (default first = Stop + resume).
- Engine wire: `agent.restart` input accepts optional `stop` / `session`.

## Deviations

- None material. Internal callers that omit modes still get product defaults; recovery paths set force+new explicitly.

## Verification

```
./node_modules/.bin/vitest run test/unit/agentManager.test.ts
./node_modules/.bin/vitest run test/unit/engineServiceProtocol.test.ts
./node_modules/.bin/tsc -p . --noEmit
```

All green (2026-07-16).

## Headless dogfood (authoritative — 2026-07-16)

Human F5 EDH was blocked (UI hard to drive; bash loops correctly live under **Terminals**, not Agents). Validation is **headless real tmux**:

```bash
cd /home/goat/tachyon-worktrees/agent-restart-modes
npm run dogfood:restart-modes
# → test/integration/restartModesDogfood.test.ts
# → .tachyon/evidence/restart-modes-dogfood/latest.json
```

| Step | Result |
|------|--------|
| protocol force/graceful modes | pass |
| force+new (pid changes) | pass |
| force+resume → new fallback | pass |
| graceful+new cooperative bash | pass |
| graceful+new sticky (trap INT) force-fallback | pass |
| product default graceful+resume → new | pass |

**Passed:** true (stamp `2026-07-16T14-49-16-707Z`).

## EDH fixture note

Bash long-runners are **terminals** (`terminals:` / inferred `kind: terminal`).  
`kind: agent` is **only** for LLM CLIs — never force bash into Agents.  
Dogfood UI: sidebar **Terminals** tab.

## Bugfix: Restart leaves sidebar "stopping…" (2026-07-16)

Default Restart = graceful+resume. `stopGracefully` sets `stoppingSince`. Resume/fresh brought the
pane back live (primer visible) but did not clear that flag → row stuck on **stopping…**, then after
15s **stop-failed**, while the editor tab worked.

**Fix:** `clearStoppingState` before start phase of `restart()`, on `resume()`, and on restart error.

**Why dogfood still saw it:** Dev Host reuses a **persistent systemd engine** (`tachyon-engine-eb13c881*`) that kept the **old bundle** without `clearStoppingState`. "Restart new section" worked because `restartFresh` always cleared `stoppingSince`; resume path did not. Stop the fixture engine (or F5 after unit stopped) so the new bundle loads.

**UI tweak:** one-click **Restart** → `force+resume` (replace process, keep conversation) — no graceful-stop handshake / no "stopping…" intermediate. "Restart new section" remains graceful+new; force variant stays force+new.

## UI follow-up (approved 2026-07-16)

Dropped VS Code QuickPick on Restart. Sidebar ⋯ now:

| Action | Mode |
|--------|------|
| **Restart** | graceful + resume (product default, 1 click) |
| **Restart new section** | graceful + new |
| **Force restart (new section)** | force + new |

Bridge/API still exposes the full matrix. Palette `Tachyon: Restart Agent` uses the default only.

## Dev Host dogfood fix (2026-07-16) — open terminal + “crash” toast

Screenshot showed `looper`/`idle` **exited**, toast “crashed — dead pane kept for postmortem”, Open terminal no-op.

**Root cause (not the restart matrix):**

1. **Stop worked.** Graceful stop sends `C-c`; bash dies with **signal 2**. Lifecycle labels that as crash/postmortem (red toast + Inspect/Restart) — not a stop API failure.
2. **Open terminal failed** because Dev Host `launch.json` sets `TMUX_TMPDIR=.tachyon/dev-host/tmux` on the Extension Host, while the **systemd engine** did not receive `TMUX_TMPDIR` (`ENGINE_ENV_KEYS` omitted it) and spawned on `/tmp/tmux-*/tachyon`. Attach used the empty private socket.

**Fixes:**

- `Terminals.open` uses absolute `tmux -S <socket>` via `attachSocketPath()` (prefers an existing socket, falls back across private/`/tmp`).
- `ENGINE_ENV_KEYS` now forwards `TMUX_TMPDIR` + `XDG_CACHE_HOME` so new engines match the EH.
- Fixture cmds simplified; silent open-terminal early-return now notifies.
- Stopped fixture engine unit `tachyon-engine-eb13c881*` and cleaned its dead sessions on the fleet socket (fleet `b349073a` untouched).

