# 338 — agent-desktop-app-resolver-native-lifecycle — plan

_Drafted from `spec.md` on 2026-07-03. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add a resolver layer to `/home/goat/tachyon-plugins/agent-desktop` before launch. The resolver returns candidate app
records rather than immediately mutating the desktop. `launch --app` consumes a selected candidate, starts it with
structured arguments, waits for a matching window when requested, focuses it using the existing focus path, and records
session ownership only when the new process/window identity is provable.

The initial implementation should prioritize Windows-host/WSL, matching the current `agent-desktop` backend. Discovery
should combine cheap and explainable sources:

- explicit executable path
- built-in alias table for common apps (`blender`, `vscode`, `discord`, `notepad`, `calc`, `explorer`)
- Windows `App Paths` registry
- Start Menu `.lnk` shortcuts
- `PATH` lookup
- Program Files / LocalAppData common directories

New CLI surface:

```bash
agent-desktop apps find <query> [--json]
agent-desktop apps list [--json]
agent-desktop launch --app <query-or-path> [--wait-window] [--timeout <seconds>] [--session <id>] [--dry-run] [--json]
```

`apps find` should return candidates sorted by confidence with a stable explanation schema. `launch --dry-run` should
show the candidate it would choose. If multiple candidates are similarly plausible, launch should fail `ambiguous` and
include candidates. The resolver must deny destructive maintenance shortcuts such as uninstall/setup/update entries for
ordinary app queries.

Ownership rules follow spec 336 but are stricter for native apps:

1. Take a pre-launch `EnumWindows` snapshot.
2. Launch the app detached from the waiting PowerShell process with structured `Start-Process -FilePath/-ArgumentList`.
3. Build a process tree from the launched pid using parent pid and process start times.
4. Wait for visible, non-tool top-level windows that were absent from the pre-launch snapshot and are owned by the
   launched pid or a verified descendant pid.
5. Own the set of matching windows, not just the first HWND.
6. Persist `(HWND, pid, process start time, executable path, class, launch timestamp, session id)` and revalidate all of
   it before cleanup.

If an app forwards to an existing instance, uses ApplicationFrameHost/MSIX, launches through a bootstrapper that cannot
be connected to a descendant process, times out without a window, or opens only preexisting windows, the result is
`launched=true, owned=false`. Cleanup must never close those windows.

PowerShell interop should treat user query strings, shortcut targets, and app paths as data. Do not construct
`powershell.exe -Command "<interpolated user text>"`. Use the existing fixed generated script plus typed arguments, or a
future encoded JSON payload, and call `Start-Process` with `-FilePath` and array `-ArgumentList`.

## Key decisions

- **Resolver before launch** — launching by fuzzy string directly is too opaque and risky. A resolver lets agents and
  users inspect what will happen.
- **Dry-run for launch** — opening desktop apps is stateful and may load private recent projects. Dry-run gives a
  consent/audit checkpoint.
- **Snapshot/process-tree ownership** — native apps vary widely. The plugin must not assume ownership just because it
  invoked an executable; it must prove a new window belongs to the launched process tree.
- **Blender as target, but not hard dependency** — Blender is the motivating example, but not every dogfood machine has
  it. Use Notepad/Calculator as guaranteed smoke if Blender is absent, while keeping Blender in optional dogfood.
- **Structured `.lnk` parsing only** — shortcut data should be resolved to target/arguments, never executed through a
  shell string.
- **Indirect MSIX/UWP frame hosts and browsers are launched-not-owned in this path** — ApplicationFrameHost and browser
  profile semantics make generic ownership unsafe. Packaged apps with direct pid/start/exe/HWND/class identity can be
  owned by the same native checks.

## Files touched

- `/home/goat/tachyon-plugins/agent-desktop/tachyon-plugin.json` — version bump and description.
- `/home/goat/tachyon-plugins/agent-desktop/README.md` — app resolver/lifecycle docs.
- `/home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/SKILL.md` — agent usage and cleanup guidance.
- `/home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh` — resolver, native launch,
  wait/focus integration, ledger ownership decisions.
- `docs/specs/338-agent-desktop-app-resolver-native-lifecycle/*` — spec records, probe, validation, dogfood.

## Risks & unknowns

- Start Menu shortcut parsing from PowerShell can be slow and may require COM.
- Some apps launch a bootstrapper that exits and hands off to a different process.
- Some apps open splash screens before the real window.
- Some apps restore an existing instance instead of creating a new process/window.
- Some apps start elevated or are blocked by UIPI, making focus/close unreliable.
- App names can be localized; display names may not match process names.
- Closing native apps may prompt to save files; cleanup should report `still_open` rather than kill.
- Blender may not be installed on the dogfood machine, so dogfood needs fallback.
- PID/HWND reuse means cleanup must revalidate executable path and process start time, not just pid/window id.
- Long waits should not couple app lifetime to the PowerShell waiter; launched apps must survive if the waiter dies.
- Resolver ambiguity can launch destructive shortcuts if deny-listing and confidence thresholds are weak.

## Visual impact

This mutates the real desktop by opening native apps. Visual proof should use `agent-screen` when a launched window is
available, but closure should rely on structured `agent-desktop` output and cleanup evidence.

## Sources consulted

- `docs/specs/334-agent-desktop-control/*` — original launch/focus/restore contract.
- `docs/specs/336-agent-desktop-session-cleanup/*` — session ledger, identity verification, cleanup safety.
- `/home/goat/tachyon-plugins/agent-desktop/*` — current v0.1.1 implementation and docs.
- Claude Fable probe `probe-f6d11802-7ca4-46ad-9ee9-3d575f91bb87` — adversarial review of native ownership, resolver
  ambiguity, PowerShell injection, MSIX/browser scope, and cleanup safety.
