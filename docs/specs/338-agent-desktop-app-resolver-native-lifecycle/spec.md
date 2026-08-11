# 338 — agent-desktop-app-resolver-native-lifecycle

_Created 2026-07-03._

**Status:** shipped
**Closure:** Commit `903d31fd` explicitly records shipping the agent-desktop app resolver; all implementation and verification tasks are checked.

## Intent

`agent-desktop` can currently launch an app only when the agent already knows a useful executable path or a narrow alias.
That is enough for controlled dogfood, but not enough for a natural user request such as "open Blender", "open Discord",
or "open Figma". The agent needs a structured way to discover installed applications, resolve a human app name to a
launchable target, start it, wait for a window, focus that window, and clean it up only when it is safe to do so.

This spec extends `agent-desktop` from ad-hoc launch to native app lifecycle primitives. It should add app discovery
(`apps find/list`), resolver explainability, `launch --app <name> --wait-window`, and conservative native-app ownership.
Native ownership is deliberately harder than Chrome session ownership from spec 336: the plugin may record `owned=true`
only when a pre-launch window snapshot proves the window is new, the window belongs to the launched process or a verified
descendant process created after launch, and cleanup can later revalidate PID, process start time, executable path, HWND,
and class. Any failure of that proof is `launched=true, owned=false` and must never be cleaned up automatically.

## Acceptance criteria

- [x] **Scenario: discover an installed native app**
  - **Given** Blender is installed on the Windows host.
  - **When** the agent runs `agent-desktop apps find blender --json`.
  - **Then** stdout lists candidate app records with source, display name, executable path or app id, confidence, and
    launch strategy.
- [x] **Scenario: explain unresolved app**
  - **Given** an app name is not installed or cannot be resolved safely.
  - **When** the agent runs `agent-desktop apps find <name> --json`.
  - **Then** the command fails or returns no candidates with structured search locations checked, not an opaque
    `not-found`.
- [x] **Scenario: launch and wait for a new native app window**
  - **Given** Blender or another native test app is installed and not already running.
  - **When** the agent runs `agent-desktop launch --app blender --wait-window --timeout 60 --session <id> --json`.
  - **Then** the plugin launches the resolved executable, waits for a top-level window, focuses it, and returns
    `window_id`, pid, process start time, class, bounds, resolver source, and `owned=true` only if identity is provable.
- [x] **Scenario: ownership proof requires snapshot diff and process tree**
  - **Given** a native app is launched with `--wait-window --session <id>`.
  - **When** a candidate window appears.
  - **Then** ownership is claimed only if the window was absent from the pre-launch `EnumWindows` snapshot, appeared after
    launch time, and its owning pid is the launched pid or a verified descendant pid with process start time after launch.
- [x] **Scenario: launcher/single-instance handoff is launched-not-owned**
  - **Given** an app forwards to an existing instance, uses a bootstrapper/updater, launches through Steam, or restores an
    already-running window.
  - **When** `launch --app <name> --wait-window --session <id>` completes.
  - **Then** stdout may return the focused window, but ledger records `owned=false` and cleanup never closes it.
- [x] **Scenario: launch of an already-running app is not overclaimed**
  - **Given** the target app is already running before the command.
  - **When** the agent runs `launch --app <name> --wait-window --session <id>`.
  - **Then** the plugin may focus/return an existing window, but the ledger records `owned=false` unless a new process
    and new window identity can be proven.
- [x] **Scenario: touched existing app returns to prior minimized state**
  - **Given** the target app was already running and minimized before the command.
  - **When** the agent runs `launch --app <name> --wait-window --session <id>` and then `cleanup --session <id>`.
  - **Then** the plugin does not close the existing window and restores the recorded minimized state.
- [x] **Scenario: conservative native cleanup**
  - **Given** a native app window was launched with `owned=true`.
  - **When** the agent runs `cleanup --session <id> --dry-run`, then `cleanup --session <id>`.
  - **Then** dry-run reports what would close; cleanup sends `WM_CLOSE`, revalidates identity first, and never kills the
    process by default.
- [x] **Scenario: native app exits before cleanup**
  - **Given** an owned native app window exits or closes itself before cleanup.
  - **When** `cleanup --session <id>` runs later.
  - **Then** cleanup reports `already_closed` or `stale`, revalidates PID/start/exe/HWND first, and does not close a
    replacement process or reused HWND.
- [x] **Scenario: unsaved-work prompt is not killed**
  - **Given** an owned native GUI app displays a save/confirm prompt during `WM_CLOSE`.
  - **When** cleanup runs.
  - **Then** cleanup reports `still_open` and never escalates to `TerminateProcess`.
- [x] **Scenario: user app/window survives cleanup**
  - **Given** a user-opened instance/window of the same app exists before the session.
  - **When** the agent launches another window/process and cleans up the session.
  - **Then** cleanup does not close the preexisting user-owned window.
- [x] **Scenario: resolver supports explicit path escape hatch**
  - **Given** an app cannot be resolved by name but the user provides a path to an executable.
  - **When** the agent runs `launch --app <absolute-path> --wait-window`.
  - **Then** the command validates that path, starts it, and reports the same lifecycle metadata as named launch.
- [x] **Scenario: resolver is inspectable before mutation**
  - **Given** the agent is about to launch a native app.
  - **When** it runs `agent-desktop launch --app <name> --dry-run --json`.
  - **Then** stdout shows the selected candidate, arguments, expected process/window hints, and no desktop state changes.
- [x] **Scenario: ambiguous resolver refuses launch**
  - **Given** multiple plausible candidates match the query, such as multiple Blender versions or standalone vs Steam.
  - **When** the agent runs `launch --app blender --json`.
  - **Then** the command returns `ambiguous`, includes ranked candidates, and does not launch anything.
- [x] **Scenario: uninstall/setup/update shortcuts are denied**
  - **Given** Start Menu contains `Uninstall Blender`, setup, updater, or maintenance shortcuts.
  - **When** the query is `blender`.
  - **Then** those candidates are denied or ranked below the launchable app and are never auto-selected.
- [x] **Scenario: hostile app query is inert data**
  - **Given** an app query contains quotes, semicolons, `$()`, backticks, ampersands, or shell-like text.
  - **When** the resolver/launcher runs.
  - **Then** the text is passed as data to a fixed script/API, never interpolated into executable PowerShell code.
- [x] **Scenario: wait-window timeout is safe**
  - **Given** a launched app never creates a suitable visible top-level window before timeout.
  - **When** `launch --wait-window --timeout <seconds>` times out.
  - **Then** stdout reports `launched=true, owned=false, wait_window=timeout`; cleanup has nothing to close unless a later
    verified window is explicitly adopted by a future command.
- [x] The resolver searches at least: explicit path, built-in aliases, Windows App Paths registry, Start Menu shortcuts,
  `PATH`, and Program Files common locations.
- [x] Resolver explain output has a stable JSON schema: `query`, `chosen`, `refused_reason`, and `candidates[]` with
  `source`, `display_name`, `target`, `arguments`, `match_kind`, `score`, `confidence`, and `denied_reason`.
- [x] The resolver never executes arbitrary shell text from shortcuts or registry values; launch arguments are structured.
- [x] Browser candidates covered by spec 336 are routed to the safer browser/session path or refused with a pointer to
  `open-url`; they do not use generic native ownership.
- [x] MSIX/UWP/AUMID candidates that surface through `ApplicationFrameHost.exe` are not owned in v1. Packaged apps with a
  direct process/window identity may be owned only when the same pid/start/exe/HWND/class checks pass.
- [x] UAC-elevated apps are launched-not-owned unless identity checks can run at matching integrity.
- [x] The CLI keeps JSON-only stdout and stable exit codes.
- [x] Docs explain that app launch can open recent files/projects and that user consent covers that desktop mutation.

## Non-goals

- No arbitrary keyboard/mouse automation.
- No screenshot capture; continue using `agent-screen`.
- No app installation.
- No UWP/MSIX deep integration beyond discovery when it falls out safely.
- No process killing by default.
- No claim that every Windows app can be owned/cleaned up. Apps that reuse existing processes or hide windows must be
  marked not owned unless identity can be proven.
- No `TerminateProcess` cleanup for native GUI apps in v1.
- No ownership of MSIX/UWP/ApplicationFrameHost windows.
- No ownership of browser apps through generic native launch; use spec 336 browser flow.
- No layout/move/resize commands.

## Open questions

- Which native app should be the required dogfood target: Blender if installed, or a guaranteed Windows app such as
  Notepad/Calculator with Blender as optional?
- How much Start Menu shortcut parsing is safe in v1: resolve `.lnk` target/args only, or support AppUserModelIDs too?
- Should native-app profile/sandbox support exist for any app class beyond Chrome, or remain app-specific?
