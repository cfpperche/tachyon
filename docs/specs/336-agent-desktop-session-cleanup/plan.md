# 336 — agent-desktop-session-cleanup — plan

_Drafted from `spec.md` on 2026-07-03. The approach, not the steps (those go in `tasks.md`)._

## Approach

Extend `/home/goat/tachyon-plugins/agent-desktop` with a persisted session ledger and cleanup commands. The shell
wrapper remains the public CLI; the Windows-host PowerShell helper continues to own Win32 window enumeration/focus/close.

The core change is that state-changing commands classify their target, but only after the plugin has a defensible
identity model:

- `owned=true`: the plugin opened the window under a dedicated session profile/process and may close it during cleanup
  after identity revalidation.
- `owned=false, touched=true`: the plugin focused/restored a preexisting window and must not close it.
- `closed=true`: cleanup/close has already processed the owned record.

The ledger should be append/update JSON under the workspace, probably `.tachyon/agent-desktop/sessions/<session_id>.json`
or `.tachyon/evidence/agent-desktop/sessions/<session_id>.json`. Each command writes enough metadata to avoid title-based
cleanup: `session_id`, schema version, host boot/session marker, `created_at`, command, URL/app, `window_id`, pid,
process start time, process name, window class, dedicated profile path, initial title, bounds, and action history.

For Chrome `open-url`, v1.1 should stop relying on Chrome's normal profile and single-instance handoff. Launch Chrome
with a per-session `--user-data-dir` under a plugin-controlled workspace path, plus `--new-window`, so plugin-owned
windows are isolated from the user's normal Chrome windows. This gives cleanup a better ownership boundary and avoids
terminating or closing windows from the user's main browser profile.

Every close path must re-enumerate the target and verify the identity tuple immediately before sending `WM_CLOSE`:

- HWND/window id matches the ledger entry.
- process name matches.
- pid matches.
- process start time matches.
- window class matches.
- for Chrome, command line/profile path matches the session profile when available.

If any field mismatches, the command marks the entry `stale` or `mismatched` and does not close that window.

Add explicit cleanup commands:

```bash
agent-desktop close --window-id <id> [--session <id>] [--json]
agent-desktop cleanup --session <id> [--json]
agent-desktop cleanup --session <id> --dry-run [--json]
agent-desktop cleanup --mine [--json]
agent-desktop sessions list [--json]
agent-desktop sessions show --session <id> [--json]
```

`open-url` should accept optional `--session <id>`; without it, it creates a new session. If a second `open-url` uses the
same session, it should reuse the dedicated session profile and add another owned window to the ledger. `launch` can
follow the same ownership contract only when it can prove process/window identity; otherwise it should record
`owned=false` and decline cleanup ownership. `focus`/`restore` should record a touched non-owned window when `--session`
is supplied, but should not create cleanup ownership.

`cleanup` sends `WM_CLOSE`, waits a bounded timeout, re-checks existence, and returns per-window result states. It must
not call `TerminateProcess` in v1.1 by default. If a window remains open after `WM_CLOSE`, report `still_open` and leave
the ledger inspectable.

Docs should be updated in the same pass to make install/runtime expectations explicit: the plugin intentionally has no
`externalTools` because it uses WSL/Windows built-ins; Chrome is a runtime prerequisite for Chrome URL opening. `doctor`
should also report these as structured preflight checks, because docs alone are not enough DX.

## Key decisions

- **Persisted ledger, not in-memory tracking** — cleanup can run after the agent command exits, after compaction, or in a
  later shell. In-memory state would not solve the overnight dogfood problem.
- **Dedicated Chrome profile per session** — Chrome's normal single-instance behavior makes ownership fuzzy. A
  per-session `--user-data-dir` gives the plugin a defensible boundary for windows it may later close.
- **Own only what the plugin opens** — this is the safest user expectation. Focused/restored preexisting windows are
  mutations but not owned resources.
- **Close by verified identity, not just HWND/id** — title/process matching caused ambiguity in v0.1.0 dogfood, but HWNDs
  can be reused. Cleanup targets the exact `window_id` returned by `open-url` only after verifying pid, process start
  time, class, and session profile.
- **Default conservative cleanup** — if the HWND is gone, report `already_closed`; if the HWND now points to a mismatched
  process/title shape, fail closed rather than closing a potentially unrelated window.
- **Dry-run/audit before destructive cleanup** — agents and humans need to inspect what the ledger claims before closing
  windows.
- **Explicit cleanup first; automatic cleanup later only if bounded** — a trap-based `--cleanup-on-exit` may be useful,
  but the foundation is explicit `cleanup --session` plus dogfood discipline.

## Files touched

- `/home/goat/tachyon-plugins/agent-desktop/tachyon-plugin.json` — bump version and improve description if useful.
- `/home/goat/tachyon-plugins/agent-desktop/README.md` — session/cleanup contract and runtime requirements.
- `/home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/SKILL.md` — agent-facing cleanup guidance and safety.
- `/home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh` — ledger, session ids,
  close/cleanup commands, JSON output.
- `/home/goat/tachyon-plugins/README.md` — plugin row if versioned behavior should be called out.
- `docs/specs/336-agent-desktop-session-cleanup/*` — spec, plan, tasks, notes, probe/dogfood evidence.

## Risks & unknowns

- HWND values can become stale or reused; cleanup must validate process/window metadata before closing.
- Chrome can reuse a process for multiple windows; v1.1 should avoid that by using a dedicated session profile. Cleanup
  should still close windows, not kill shared Chrome processes.
- `WM_CLOSE` may prompt or fail; the command needs a clear partial result shape.
- A newly opened Chrome window may load slowly; the ledger should update from initial `Untitled` to later observed title
  when possible, but cleanup must not depend on that title.
- Concurrent sessions may update ledgers at the same time; writes should be atomic enough for shell usage.
- Workspace path discovery matters when running from an installed plugin path; the ledger must land in the caller's
  workspace, not inside the plugin cache.
- Leaving orphaned ledgers is acceptable; leaving orphaned windows is not.
- PowerShell invocation must not interpolate window titles or URLs into executable script text. Pass structured data as
  arguments or JSON and emit structured JSON; hostile titles with quotes/backticks must not become code.
- Reboot invalidates HWNDs; ledger entries need a host boot marker or cleanup must treat old sessions as stale.

## Visual impact

No Tachyon UI changes are required. The visible desktop impact is fewer orphaned windows after dogfood. Visual proof
should use `agent-screen` before cleanup to prove the owned window existed, then `agent-desktop list-windows` after
cleanup to prove owned windows are gone.

## Sources consulted

- `docs/specs/334-agent-desktop-control/*` — v0.1.0 contract, dogfood logs, and the bad cleanup experience.
- `/home/goat/tachyon-plugins/agent-desktop/*` — current plugin command/docs baseline.
- User dogfood report on 2026-07-03: overnight machine had multiple Chrome windows opened by the plugin.
- Claude Fable probe `probe-4e4c0a43-c447-4207-b02d-40c6d107046b` — identified blockers around HWND reuse, Chrome
  process handoff, undefined close semantics, ledger lifecycle, dry-run, and lack of automatic cleanup backstop.
