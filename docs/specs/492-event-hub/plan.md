# 492 — event-hub — plan

_Drafted from `spec.md` on 2026-08-06. The approach, not the steps (those go in `tasks.md`)._

## Approach

No implementation ships in this delivery. What follows is the recommendation this design reaches,
for the maintainer and the adversarial duet with codex to argue over before any code changes — per
the process already decided and recorded on `t-a8f4a9` ("Quando puxada: dueto adversarial com codex
ANTES de qualquer implementação").

Three things the original idea asked for, evaluated separately against what's measured (`spec.md`):

1. **File watcher for tasks** — already exists, do nothing. `src/workspace/Workspace.ts:3252`
   watches `.tachyon/tasks/*.json` with a 75ms debounce (`TASK_FILE_REFRESH_DEBOUNCE_MS`,
   `Workspace.ts:444`) and calls `deps.onViewsChanged("tasks")` engine-side, once, regardless of
   window count or writer identity.
2. **Centralized poll for tmux/PIDs** — genuinely missing; the narrowest real gap. If pursued: give
   tmux/RuntimeOps/Plugins each a `ViewKind` (extending `EngineHost.ts:11`'s `"agents" | "pins" |
   "tasks" | "commands" | "schedules" | "handoff" | "probes"`), add one engine-side poll subsystem
   (same shape as the existing `monitor.tick()` inside `Workspace.tick()`'s 3s cycle,
   `Workspace.ts:6325-6339`) that calls `onViewsChanged(newKind)` when its poll observes a change,
   and wire the three panels' existing `PanelWorkGate`-gated `bind()` handlers to that door — the
   same pattern Board/Fleet/agents already use, not a new one. This reuses `onViewsChanged`'s
   already-coalesced, already-trailing-edge-safe emit path (`DaemonEngineHost.ts:363-376`) instead
   of inventing a second one.
3. **Payload-carrying delta push** — rejected for now (see Key decisions). The measured D5 cost
   (three full workspace sweeps every 3s per open panel) is round-trip count inside `deps.collect()`
   (`src/extension.ts:1752-1937`, 3-4 serial socket calls per workspace), not payload size; a delta
   mechanism doesn't touch that. If (2) and the round-trip fix below land, re-measure before
   considering this again.

A smaller, separately-justified fix the D5 measurement actually asks for: `deps.collect()`'s
per-workspace calls (`engineLogHealth`, `tmux.health`, `companion.status`, `worktrees.classified`,
`extension.ts:1770,1798,1811,1852`) run serially; nothing in the measured evidence requires them to.
Parallelizing them (or folding them into one engine-side aggregate RPC — the same one-pass shape
`buildBoardSnapshot` already uses per "dueto F4", `src/tasks/boardSnapshot.ts:19-20,54-56`) would cut
`collect()`'s latency without touching the event/push architecture at all, independent of whether
(2) or (3) ever ship.

Separately: for views that already have a push door (Board via `onTasksChanged`, and every
`ViewKind` in `EngineHost.ts:11`), the client's own redundant 3s `setInterval`
(`src/webview/{fleet,engine,worktrees,...}/main.tsx` — 14+ call sites, each `setInterval(...,
3000)`) is largely dead weight once that panel is confirmed to react correctly to `views-changed` —
`src/webview/BoardPanel.ts:34-38` already documents this poll as one of three redundant doors.
Retiring it (once verified safe per view) removes duplicate `deps.collect()` sweeps without adding
anything.

## Key decisions

- **Reuse `onViewsChanged`/`PanelWorkGate`, do not build a second event mechanism** — chosen because
  the existing one is production-proven (t-b51923's storm was real, the fix is measured and
  shipped) and already answers the trailing-edge-drop question; rejected building a parallel pub/sub
  hub with its own topics/subscribe protocol because it would duplicate solved infrastructure and
  risk re-opening a class of bug (invalidation storms, lost cursors) this repo already paid to close
  once.
- **Centralize tmux/RuntimeOps/Plugins polling in the daemon, scoped narrowly** — chosen because it's
  the one piece of the original idea with no existing coverage, confirmed by explicit "no fan-out
  door" comments in the code (`TmuxPanel.ts:63-65`, `RuntimeOpsPanel.ts:125-127`,
  `PluginsPanel.ts:189-190`); rejected leaving it as-is because it duplicates a subprocess poll
  (`execFile('tmux', ...)`) per window per visible panel against one shared tmux socket — exactly the
  "N windows repeating the same read" case `t-a8f4a9` was written to fix.
- **Reject payload-carrying delta push, for now** — chosen (as a rejection) because the measured cost
  (D5, `j-8160ffd8f31f`) is round-trip count, not payload size, so a delta mechanism wouldn't fix the
  problem it was justified by; and because it is the one piece of the original idea with an
  unanswered "what happens when the last delta is dropped" question — today's invalidation-only
  events are safe to coalesce/drop specifically because they carry no state
  (`DaemonEngineHost.ts:351-355`), and a payload delta breaks that safety property without a new
  design for it. Rejected building it speculatively "since we're already touching this area" — this
  repo's own guidance names that exact anti-pattern (avoid speculative hardening).
- **Reject transport change (socket → HTTP/WebSocket)** — chosen (rejection) because no measurement
  here shows the Unix domain socket transport itself is a cost; the per-workspace daemon is already
  shared cross-window over it. Changing transport without evidence would be architecture invented to
  fit a proposal, which is exactly the failure mode this task was written to avoid ("A design that
  assumes the problem is a design that invents one").
- **Reject "build the full hub exactly as originally scoped"** — chosen (rejection) because
  measurement shows most of it (persistent shared daemon, versioned event journal, engine-side file
  watching, proven coalescing, proven catch-up) already exists; building a new one on top would be
  redundant work against a solved problem, not a fix for the measured cost.
- **Fix `deps.collect()`'s serial round trips as a separate, smaller change** — chosen because it is
  the most direct fix for the actual measured D5 cost, is independent of whether any push mechanism
  changes, and follows an already-proven shape in this codebase (`buildBoardSnapshot`'s one-pass
  contract, "dueto F4"); rejected bundling it into the event-hub conversation because it's a plain
  performance fix with no lifecycle/protocol/actor questions attached — SDD is for the cross-cutting
  parts of this problem, not this one.

## Files touched

None in this delivery — design only. If the narrow recommendation above (tmux/RuntimeOps/Plugins
centralization) is later approved and implemented, it would touch: `src/workspace/EngineHost.ts`
(`ViewKind` union), `src/workspace/Workspace.ts` / `src/workspace/DaemonEngineHost.ts` (new poll
subsystem + `onViewsChanged` call), `src/webview/TmuxPanel.ts`, `src/webview/RuntimeOpsPanel.ts`,
`src/webview/PluginsPanel.ts` (wire into the fan-out; retire or shrink the client 3s poll), and
`docs/architecture/dogfood-product-boundary.md`'s registry table (a new engine↔extension surface
needs a forcing-function test per that doc's rule, in the same landing — not a follow-up).

## Risks & unknowns

**Actor × trigger coverage for view invalidation** — the habit `docs/project-guidance.md` §"Who else
can reach this?" names as a test-case list, not ceremony:

| Actor | Trigger | Reaches invalidation via | Coverage today |
|---|---|---|---|
| Interface | mutating command (move task, create pin, run agent action) | `extensionOperationService.ts` → explicit `onViewsChanged(kind)` call (e.g. `:275` pins, `:293` schedules, `:364,462,565,572,651` agents, `:448,456` commands, `:665` handoff) | covered |
| Interface | window create (open a new VS Code window on an attached workspace) | `clientRegistry.attach` → new session against the existing daemon (`engineSupervisor.ts:172-206`); first `sync()` | covered — daemon is shared, not re-spawned |
| Interface | window restart/reload | new extension-host process, new client, lost cursor → `resynced`/`engineChanged` forces `refreshAll()` (`extension.ts:2183-2194`) | covered |
| Interface | window resume (panel hidden → visible) | `PanelWorkGate` delta replay or resync (`panelWorkGate.ts:170-184`) | covered |
| Agent (Bridge) | mutate task state | `.tachyon/tasks/*.json` file write → engine-side watcher (`Workspace.ts:3252`) → `onViewsChanged("tasks")`, regardless of writer | covered — file-watched, writer-agnostic |
| Agent (Bridge) | mutate agent/pin/schedule state | must reach the same `onViewsChanged(kind)` call sites Interface mutations use | **not verified** — traced only as far as this repo's boundary; see Open Questions in `spec.md` |
| Tachyon itself | internal tick (3s `Workspace.tick()` → lifecycle/monitor/scheduler/backstop/runtimeSlack/gatedCompletion, `Workspace.ts:6325-6339`) | each subsystem must itself call `onViewsChanged` when it mutates visible state | covered per call site today; **structurally fragile** — a new subsystem added later that forgets the call produces a silently-stale view with no test catching it, the same shape as `t-e73e54`/`t-17d885` named in project guidance |
| Tachyon itself | engine restart / upgrade (daemon binary changes) | client sees `engineChanged: true` → `refreshAll()` | covered |
| Tachyon itself | daemon crash + supervisor relaunch | new daemon process/journal; existing clients' next `sync()` detects the changed identity and resyncs | covered by the same `engineChanged` path, contingent on `engineSupervisor.ts`'s probe-and-reuse logic holding under a crash (not independently verified here) |
| Tachyon itself | fork (new agent lineage created) | new task/agent rows → same file-watch or explicit-call paths above | covered, same as ordinary create |

The one open cell (Agent/Bridge mutating non-file-backed state) is the same class of gap this repo's
guidance names by name (`t-57a00a`: "built for Agent→Agent; the Interface writes straight to the
store") — worth a fail-before test at implementation time, not an assumption now.

**What happens when the last delta is dropped — answered for what exists, and for what was
rejected:**

- *Today's invalidation-only events* (what exists, and what the narrow recommendation reuses): safe
  by construction. `DaemonEngineHost.onViewsChanged` coalesces a burst but guarantees the trailing
  invalidation of that burst is always emitted (`DaemonEngineHost.ts:357-361`); it is lossless
  specifically because the event means "this view is stale," never "here is what changed"
  (`DaemonEngineHost.ts:351-355`). Client-side, `PanelWorkGate` extends the same guarantee across
  hidden time: while hidden, distinct suppressed kinds are journaled (bounded at 64 entries,
  `panelWorkGate.ts:80`); on reveal, each distinct kind replays once, or — if the window overflowed,
  or the daemon's own cursor was lost underneath it — a full resync runs instead of trusting a
  partial replay (`panelWorkGate.ts:47-55,170-184`). A dropped "last delta" here is a dropped
  invalidation SIGNAL, and the signal is always redundant with the fact that the panel will re-fetch
  anyway; there is never state carried only in the dropped event.
- *A hypothetical payload-carrying delta* (the rejected part of the original idea): would NOT have
  this property. If the payload itself carries the change ("here is what moved," not "something
  moved"), then dropping the last one loses information no subsequent event recovers — the exact
  failure this repo's guidance calls out by name ("Swallow the last one and the view is stale
  forever, with no second chance"). Nothing in this repo has designed a catch-up for that case
  (ordered payload replay, versioned diffing, partial-application semantics), which is the concrete
  reason it's rejected now rather than deferred-and-assumed-solvable.

**Dogfood↔product boundary**: any new engine↔extension surface (a new `ViewKind`, a new poll
subsystem) is new host-touchpoint code per `docs/architecture/dogfood-product-boundary.md`'s own
rule — it would need a forcing-function test in the same landing, not a follow-up, and a new
registry row. Not evaluated further here since nothing ships with this spec.

**Debugging cost**: the task named this as a cost to weigh. It is already being paid today — tracing
"is `sync()` a push or a poll" for this spec required following four files (`extension.ts` →
`WorkspaceClient.ts` → `controlClient.ts` → `eventJournal.ts`) to discover the daemon's `readEvents`
is synchronous and non-blocking, i.e. today's "event" system already reads like request/response
with extra steps. The narrow recommendation above adds no new debugging surface beyond what the
existing fan-out already has; the rejected payload-delta option would.

## Visual impact

None — no UI changes in this delivery.

## Sources consulted

- `docs/project-guidance.md` §"Measurement and diagnosis", §"Who else can reach this?", §"Verification economy"
- `docs/architecture/dogfood-product-boundary.md` (full)
- `t-a8f4a9` (this task) journal, all 4 entries, esp. `j-8160ffd8f31f` (D5 measurement) and `j-2416dd200b9c` (runtime-api projection seam note)
- `t-fdb269` (analogous "track the option, gated, no adoption yet" framing)
- `docs/specs/485-standalone-section-apps/tasks.md` D5-D8 entries
- `docs/specs/335-mission-control-board/notes.md` (dueto F4)
- `src/workspace/EngineHost.ts`, `src/workspace/DaemonEngineHost.ts`, `src/workspace/VsCodeHost.ts`, `src/workspace/Workspace.ts`
- `src/shell/WorkspaceClient.ts`, `src/shell/WorkspaceClientRegistry.ts`
- `src/engine-service/controlClient.ts`, `src/engine-service/controlServer.ts`, `src/engine-service/engineSupervisor.ts`, `src/engine-service/eventJournal.ts`, `src/engine-service/protocol.ts`, `src/engine-service/pollingWatcher.ts`
- `src/extension.ts` (`makeControlModelHost`/`deps.collect`, `startClientSync`, `onViewsChanged` fan-out)
- `src/cockpit/model.ts` (`buildCockpitModel`)
- `src/tasks/boardSnapshot.ts`
- `src/webview/shared/panelWorkGate.ts`, `src/webview/shared/SectionPanelManager.ts`
- `src/webview/BoardPanel.ts`, `src/webview/FleetPanel.ts`, `src/webview/TmuxPanel.ts`, `src/webview/RuntimeOpsPanel.ts`, `src/webview/PluginsPanel.ts`
- `src/webview/{fleet,engine,worktrees,settings,overview,runtime-config,handoff,human-inbox,inspector,execution-graph,plugins,runtime-ops,mission-control}/main.tsx` (client poll timers)
- `src/webview/shared/control/messages.ts:337-340` (named cost of serial `collect()`)
