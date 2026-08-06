# 492 — event-hub

_Created 2026-08-06._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

`t-a8f4a9`'s idea: today N open VS Code windows each independently ask the engine "what's new?"
roughly once a second, and every open standalone panel (Fleet, Engine/Cockpit, Worktrees, Settings,
Overview, Runtime Config, Handoff, Human Inbox, Inspector/Tmux, Execution Graph, Plugins, Runtime
Ops, Mission Control — 14+ webview entry points, each with a literal `setInterval(..., 3000)`)
separately re-derives its own model on a 3-second client timer regardless of whether anything
changed. The proposal was an engine-side event hub: sockets, topics, subscription, publishing
deltas instead of N windows re-polling.

Measured from source (not runtime-profiled — see "What was and wasn't measured" below): **most of
that hub already exists.** One persistent daemon per workspace root is already shared across every
attached VS Code window (`src/engine-service/engineSupervisor.ts:172-206`, confirmed by
`eventJournal.ts:100-103`: "other windows attach to this workspace's singleton engine rather than
starting another writer"). It already carries a versioned, engine-side event journal
(`schemaVersion` fields throughout `src/engine-service/protocol.ts`) with
`views-changed`/`activity-appended`/`notice`/`ui-unavailable` events. It already coalesces bursts
with a proven leading-edge-immediate/trailing-edge-guaranteed policy
(`DaemonEngineHost.onViewsChanged`, `src/workspace/DaemonEngineHost.ts:342-376`, t-b51923 — a real
production storm, measured at 28-40 events/s with two agents running, coalesced down to ~2.4/s).
It already watches `.tachyon/tasks/*.json` and config files engine-side, once, regardless of window
count or writer identity (`src/workspace/Workspace.ts:3230-3253`, 75ms debounce via
`TASK_FILE_REFRESH_DEBOUNCE_MS`, `Workspace.ts:444`). And it already has a client-side catch-up
mechanism — `PanelWorkGate` (`src/webview/shared/panelWorkGate.ts`) — that answers exactly the
"what happens when the last delta is dropped" question this repo's own coalescing lesson demands: a
bounded per-panel journal replays each distinct suppressed invalidation kind once on reveal, and
falls back to a full resync when the window overflows or the daemon's own event cursor was lost
(crash, restart, upgrade).

So the actual gap is narrower than "build an event hub," and it sits in a different place than the
task's original framing pointed:

1. **The originally-named "poll interno para tmux/PIDs"** is real but NOT centralized today — tmux
   and PID liveness for the Inspector, Runtime Ops, and Plugins panels is polled per open window,
   per visible panel, entirely inside each VS Code window's own extension-host process
   (`src/webview/TmuxPanel.ts:59-65`, `src/webview/RuntimeOpsPanel.ts:125-127`,
   `src/webview/PluginsPanel.ts:189-190` each say, verbatim, there is "no fan-out door" — these
   three views were deliberately left out of the daemon's `ViewKind` set: `"agents" | "pins" |
   "tasks" | "commands" | "schedules" | "handoff" | "probes"`, `src/workspace/EngineHost.ts:11`).
   Two windows with the Tmux inspector open run two independent `execFile('tmux', ...)` polls
   against the one shared, single-user tmux socket every 3 seconds.
2. **The measured cost this task was promoted to P1 on** (SDD 485 D5, this task's journal entry
   `j-8160ffd8f31f`: "each visible Engine panel runs a full `deps.collect()` plus a
   `buildCockpitModel` every 3s poll, and `collect` walks every attached workspace") is not a
   payload-size problem. `buildCockpitModel` (`src/cockpit/model.ts:386`) is pure, synchronous, and
   cheap at real fleet sizes (~6 chips per `docs/specs/335-mission-control-board/notes.md:84`). The
   cost is that `deps.collect()` (`src/extension.ts:1746-1937`) runs 3-4 **serial** engine round
   trips per attached workspace (`engineLogHealth`, `tmux.health`, `companion.status`, conditionally
   `worktrees.classified`) — and every open+visible standalone panel runs this full sweep
   independently, on its own 3s client timer, even for views (Board, agents, tasks) that already
   have a push door telling them exactly when something changed.
3. **"Push de delta em vez de re-post do modelo inteiro"** — a genuine payload-carrying delta — is
   the one part of the original idea that doesn't exist yet, and it's the part that would NOT fix
   (2): the measured cost is round-trip count, not the size of what comes back. It is also the one
   part with unsolved risk: today's `views-changed` events are safe to coalesce and safe to drop
   only because they carry no payload (this repo's own "trailing edge is the safety property"
   lesson, `docs/project-guidance.md`; `DaemonEngineHost.ts:351-355` states it directly: "It is an
   invalidation, not a change"). A delta with a payload cannot be coalesced or dropped the same way
   without losing information, and nothing in this repo has designed that catch-up yet.

"Done" for this spec is a design a reader can disagree with, not new code: a measured account of
what already exists, a scoped recommendation for the one place a real un-centralized poll persists,
and an explicit rejection — with reasons — of the bigger hub the task originally described.

### What was and wasn't measured

Measured, from source, with file:line citations throughout this document: call topology (how many
round trips, how often, from where), literal poll intervals, and which views do and don't have a
push door. Not measured: live wall-clock latency of one round trip or one `collect()` sweep. This
task is read-only investigation — no implementation, no `verify:full`, and two other agents hold
live engine/webview surfaces this session — so getting a real latency number would have meant
instrumenting `src/` or running the product live, both out of scope for a docs-only delivery.
Frequency and call-graph shape are the primary findings this repo's own guidance asks for first
(`docs/project-guidance.md` §"Measurement and diagnosis": "Measure frequency before cost... Cost per
call is the cheaper number to get and the easier one to act on, which is exactly why it gets
reported first and anchors the whole diagnosis to the wrong axis"), and they are what's below. A
wall-clock pass is named as follow-up work in Open questions.

## Acceptance criteria

- [ ] Documents the literal, cited poll intervals and round-trip counts in the current architecture
      (client webview timers, the engine daemon sync loop, `deps.collect()`'s per-workspace round
      trips).
- [ ] Names every existing push/invalidation mechanism already in the codebase (event journal,
      `onViewsChanged` coalescing, file watchers, `PanelWorkGate` catch-up) rather than assuming
      none exists.
- [ ] States the actor × trigger list for what can invalidate a view and what can interrupt a
      window's connection to the engine, using this repository's actor vocabulary (Interface, Agent
      via Bridge, Tachyon itself) and trigger vocabulary (create, restart, resume, fork,
      crash-recovery).
- [ ] Gives an explicit, concrete answer to "what happens when the last delta is dropped" for both
      the mechanism that already exists (invalidation-only) and the mechanism the original idea
      asked for (a payload-carrying delta).
- [ ] Records rejected alternatives with reasons, including the option of building the originally
      scoped hub exactly as first proposed.
- [ ] Reaches an explicit recommendation — build nothing further, build the full hub, or build a
      narrower extension of what exists — and states the measurement that supports it.

## Non-goals

- Not implementing anything. No `src/` change ships with this spec.
- Not a transport redesign (Unix domain socket → HTTP/WebSocket/etc.) — no measurement here suggests
  transport choice is the bottleneck.
- Not a redesign of the existing event coalescing (`DaemonEngineHost.onViewsChanged`) or catch-up
  (`PanelWorkGate`) mechanisms — both are proven in production (t-b51923) and this spec's own
  conclusion leans on reusing them, not replacing them.
- Not a cross-machine/cross-daemon sync design — every measurement here is about one daemon and the
  windows attached to it.
- Not the adversarial duet with codex the task's own decided process requires before
  implementation — this spec is the input to that duet, not a substitute for it.

## Open questions

- **Does a Bridge (Agent) mutation always reach the same invalidation path an Interface mutation
  does?** Task/config state is file-watched (`Workspace.ts:3230-3253`), which naturally covers any
  writer regardless of identity — but agent/pin/schedule state invalidation, where it isn't
  file-backed, goes through explicit `onViewsChanged(kind)` call sites
  (`src/engine-service/extensionOperationService.ts` — many, e.g. `:275,293,364,448,565`). Whether
  every Bridge-reachable mutation of that state runs through the same call sites, or a second path
  that could skip them (the shape this repo already hit once — project-guidance's `t-57a00a`: "built
  for Agent→Agent; the Interface writes straight to the store"), was not traced into the Bridge/MCP
  server, which lives outside this repository. Needs verification at the point of use before any
  implementation touches this area, per this repo's own rule ("Verify at the point of use, never by
  text search").
- **Live wall-clock cost of one `collect()` sweep and one `sync()` round trip.** This spec measured
  call topology and frequency; it did not instrument a live daemon for latency (see "What was and
  wasn't measured" above). Worth a short, dedicated follow-up measurement before committing
  engineering time to the recommendation in `plan.md`.
- **Would centralizing tmux/PID polling in the daemon change its actual measured value at real usage
  patterns** — how often are 2+ windows on the same workspace root actually open with the
  Tmux/Runtime Ops/Plugins panel simultaneously visible? Not measured here; the gap is real by
  inspection of the code, but its cost has the same "measure frequency before cost" risk as the
  original ask if nobody checks how often it's actually hit.
