# 504 — truthful sidebar boot state — plan

_Drafted from `spec.md` on 2026-08-13. Planning only; no production source changed._

## Live measurements

### Configured workspace reload

The most recent real reload of the main Tachyon workspace (2026-08-13 17:27 local) was reconstructed
from the VS Code extension-host log, the running engine's `/proc` start tick, the engine ring log,
and file timestamps. These clocks agree in UTC; values below are relative to VS Code beginning
Tachyon activation at `20:27:52.959Z`.

| Milestone observed live | Relative | Phase duration |
|---|---:|---:|
| VS Code begins Tachyon `activate` | 0 ms | — |
| engine process starts | 1,181 ms | activation/workspace selection → engine spawn: 1,181 ms |
| engine installs its log ring | 2,066 ms | process bootstrap: 885 ms |
| config last-known-good is written | 2,274 ms | workspace/config load after log start: 208 ms |
| orphan-footprint startup work finishes | 2,642 ms | workspace startup work: 368 ms |
| control socket exists | 2,654 ms | final bind: 12 ms |
| VS Code reports eager activation complete | 2,875 ms | shell attach/provider registration tail: 221 ms |

The first fleet cannot be posted before provider registration, because production awaits
`addWorkspace()` before registering `SidebarPrototypeProvider`. Thus 2.875 s is the measured upper
bound from activation to the first possible list in this run. The engine-control/start path consumed
2.654 s (92%); no single timer accounts for the owner's 10–30 s report, and this run does **not**
justify replacing the state design with a latency-only fix.

Two other configured reloads in the same live VS Code log took 1.666 s and 3.479 s from Tachyon
activation to `Eager extensions activated`. The observed ordinary envelope is therefore 1.7–3.5 s;
5 s is a defensible initial point for changing “Starting…” to “Taking longer than usual…”, not a
failure deadline.

### First sync and first list

They are not sequential gates in the current product:

- `addWorkspace()` awaits the engine client attach and receives the initial presentation snapshot.
- Provider registration follows the awaited attach; resolving the webview calls `push()`, whose
  `loadSidebar()` produces the first list.
- Event sync starts on a 1,000 ms timer after attach and is for subsequent invalidations/resync. It
  does not have to finish before the initial list.

Therefore the UI contract should not narrate “first sync” as a mandatory progress step. The only
honest pre-list fact the shell has is discovery plus attach phase; the first successful sidebar
projection is the readiness edge.

### Genuinely absent workspace

A separate live VS Code window with no `tachyon.yml` recorded Tachyon activation only when the view
was opened: `2026-08-13 12:53:46.798`, activation event
`onView:tachyonSidebarPrototype`. No engine process, config LKG write, Bridge, or agent startup followed.
In this path the host already has the definitive answer synchronously: it enumerates
`vscode.workspace.workspaceFolders`, calls `hasConfig(folder)` for each, the configured set is empty,
and registers the provider without awaiting `addWorkspace()`.

The log does not expose a separate activation-complete timestamp for this non-startup activation, so
it cannot support a fabricated millisecond duration. What it does prove is the boundary that matters:
absence is knowable in the activation turn and does not depend on engine startup or first sync. The
empty state may be sent immediately once that check completes; it must not be the webview's default
before the check.

### Measurement constraint

A fresh reload requested during this investigation was correctly refused by the host because two
other agents were working. The plan uses the already-live reload trace above rather than disrupting
their turns. Implementation should add test-only timestamp capture around the same boundaries and
collect a broader reload sample before locking the delayed threshold.

## What the host already knows but does not project

| Existing fact | Current owner | Missing projection |
|---|---|---|
| open folders and `hasConfig(folder)` result | `extension.ts` before the startup loop | confirmed-unconfigured vs configured-starting |
| attach pending / attached / rejected | `WorkspaceClientRegistry` slot and `attach()` promise | starting vs ready vs failed, per workspace |
| workspace root/name before attach | VS Code `WorkspaceFolder` | identity for starting/failure copy |
| engine connection warning and thrown attach error | `addWorkspace()` / sync loop | durable sidebar failure rather than toast-only information |
| first usable sidebar projection | `SidebarPrototypeProvider.push()` success | ready edge |
| resync/engineChanged events | `WorkspaceClient.subscribe()` | reconnecting state only if the current fleet cannot remain safely visible |

No new status-bar channel or percentage machinery is needed. The missing piece is a small shell-owned
projection of facts already present across discovery, registry attach, and first projection.

## State design

Use a window projection containing one entry per open folder and an overall discovery marker. A
folder entry is `unconfigured`, `starting`, `ready`, or `failed`; `starting` carries a named coarse
phase (`connecting-engine` or `loading-sidebar`) and `startedAt`, while `failed` carries the existing
diagnostic summary. “Delayed” is presentation derived from elapsed time, not another lifecycle state.

| State | Sidebar text/action |
|---|---|
| discovery not yet received | “Checking this window for Tachyon workspaces…”; no Initialize |
| configured, attaching (<5 s) | “Starting Tachyon for {folder}…” plus indeterminate motion; no percentage/action |
| configured, delayed (≥5 s) | “Tachyon is taking longer than usual to start for {folder}.” + “Show Output” |
| configured, failed | “Tachyon could not start for {folder}: {summary}.” + Retry + Show Output |
| all folders confirmed unconfigured | existing “No Tachyon workspace” copy + Initialize Tachyon |
| first fleet ready | existing normal sidebar |

For multi-root, ready fleets remain visible while starting/failed folder notices are rendered in the
same sidebar; one slow folder must not blank healthy projects. Removing the last configured folder
re-runs discovery and reaches confirmed-unconfigured. A retry returns only that folder to starting.

## Actor × trigger cases

| Actor | Trigger | Expected transition |
|---|---|---|
| Interface | reveal/open view before activation settles | unknown → discovered state; never default to absence |
| Interface | Retry after attach failure | failed → starting → ready or failed |
| Interface | Initialize in confirmed-empty window | existing creation path; unconfigured → starting → ready |
| Agent | Bridge/config mutation that creates configuration | discovery refresh → starting → ready |
| Agent | refresh while attach is pending | state remains starting; no duplicate attach |
| Tachyon | cold activate or window reload | unknown → per-folder discovered states |
| Tachyon | folder added/removed | recompute only affected membership and overall empty result |
| Tachyon | engine restart/upgrade/reconnect | keep last-known-good fleet if safe and mark reconnecting; otherwise starting |
| Tachyon | attach failure or crash recovery exhaustion | failed with named diagnostic; never unconfigured |

## Implementation slices, in order

1. **Protocol and fail-before tests.** Extend the sidebar message/model with discovery and per-folder
   lifecycle facts. Add actor × trigger tests, including a red guard showing that an initial empty
   array can no longer render confirmed absence.
2. **Host projection.** Populate states from folder discovery, registry attach, attach failure, first
   projection, membership changes, and retry. Reuse existing diagnostic recording and attach
   convergence; do not add a second engine state machine.
3. **Sidebar rendering.** Render unknown, starting, delayed, and failed notices while preserving ready
   fleets and the confirmed-empty welcome. Localize every human-facing string.
4. **Failure/recovery wiring.** Make Retry target one workspace and prove engine reconnect, upgrade,
   crash recovery, and multi-root partial failure do not collapse to absence.
5. **Live timing and visual proof.** Capture timestamped cold/reload/absent traces, tune the delayed
   threshold from those observations, and inspect the real sidebar at 880 px and 360 px. Only after
   this measurement decide whether any engine-start optimization deserves its own task.

## Key decisions and rejected alternatives

- **Project discovery before empty UI** — it is already available synchronously; rejected deriving
  absence from `fleets.length`, which repeats the defect.
- **Facts plus coarse phases, not percentages** — the host can name discovery/attach/projection but
  cannot estimate completion; rejected a progress bar because its percentage would be invented.
- **Sidebar-only first** — it directly contains the false claim and the measured normal wait is under
  3.5 s; rejected a status-bar item because no measurement shows another surface is needed.
- **Delayed is not failed** — elapsed time changes copy and reveals diagnostics, while an explicit
  rejection changes lifecycle; rejected timeout-to-empty and timeout-to-failure because both lie.
- **Preserve last-known-good during reconnect where safe** — avoids replacing useful data with a
  spinner; rejected blanking every fleet on any engineChanged event.

## Files expected in the implementation task

- `src/webview/sidebar/messages.ts` — lifecycle/discovery wire contract.
- `src/webview/sidebar/App.tsx` — truthful transient, delayed, failed, and confirmed-empty rendering.
- `src/webview/SidebarPrototype.ts` — host projection and first-fleet readiness edge.
- `src/extension.ts` and `src/shell/WorkspaceClientRegistry.ts` — discovery/attach/failure facts and retry seam.
- Sidebar/extension unit and browser tests plus localization bundles — actor × trigger and two-width proof.

## Risks and unknowns

- A retained webview may display its previous document before the new host can message it. Persisted
  client state must therefore be treated as unknown on a new host incarnation unless explicitly
  attested to that incarnation.
- Engine reconnect can retain a valid last fleet; do not regress it into unnecessary blank loading.
- Multi-root ordering and folder removal can race an in-flight attach. Registry cancellation already
  defines that boundary and should remain the authority.
- The observed 10–30 s report did not reproduce in the three measurable configured traces. Do not
  claim it is fixed by a 2.9 s run; collect more cold-start samples during implementation.

## Visual impact

The false empty welcome becomes a compact neutral startup notice, then a more explicit delayed or
failed notice when warranted. The implementation task must anchor before building and inspect 880 px
and 360 px, verifying that long folder/error text wraps without pushing tabs or actions out of view.

## Sources consulted

- t-bb152a task body and owner screenshot description.
- Live VS Code logs under `.vscode-server/data/logs/20260813T122617/exthost{1,2,3,4}`.
- Live engine process `/proc/2797543/stat`, engine ring log and runtime socket timestamps.
- `src/extension.ts` activation, workspace discovery, attach, sync, and membership paths.
- `src/shell/WorkspaceClientRegistry.ts`, `src/shell/WorkspaceShellHandle.ts`.
- `src/webview/SidebarPrototype.ts`, `src/webview/sidebar/App.tsx`, and sidebar message contract.
- `docs/specs/382-persistent-engine-shell-boundary/spec.md` for persistent-engine reload authority.
