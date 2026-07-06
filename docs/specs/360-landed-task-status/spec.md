# Spec 360 — `landed` task status (first-class state + board column)

## Intent

Promote **"landed"** (a task whose work has shipped but whose parent SDD spec is still gating, so it can't
close yet) from the **derive-only board flag** introduced in t-82f870 to a **first-class `TaskStatus`**.

Why (maintainer, 2026-07-06): the derive-only version left the persisted status as `active`, so status-based
**filter / search / API / next_task** could not tell landed from genuinely-in-flight work — the distinction
lived only in one board render. It also used a **liveness heuristic** ("no live agent") that *flaps* (a card
flips back to in-flight the instant an agent's pane twitches). A real status is honest in the data model,
filterable everywhere, stable, and earns its own kanban column (columns = workflow stages).

Supersedes t-82f870's implementation (commits dbd2d38 + 59bca6f) — that derive-only machinery is **removed**
and replaced by the real status below.

## Model

- **New status `landed`** in `TASK_STATUSES` (src/tasks/types.ts), positioned **between `active` and `done`**.
- **Board columns** (src/tasks/boardModel.ts `BOARD_COLUMN_STATUSES`): `inbox · triaged · active · landed · done`
  — 5 always-on columns. **`dropped` stays a toggle-reveal bucket**, never a column (335 unchanged for dropped).
- **Transitions** (src/tasks/TaskStore.ts `TASK_STATUS_TRANSITIONS`):
  - `active: ["landed", "done", "triaged", "dropped"]` (ADD `landed`)
  - `landed: ["done", "active", "triaged", "dropped"]` (NEW — `done` = close when spec ships; `active` = reactivate; others = re-triage/abandon)
  - all others unchanged (`inbox`/`triaged`/`done`/`dropped`).
- **SDD gate** (`assertSddStatusUpdateAllowed`): the existing throw on `→ done` while the sdd artifact is not
  `shipped` **stays, and now applies to `landed → done` too**. `active → landed` and `landed → active` are
  NEVER gated. So the natural flow for gated work becomes: finish → **set `landed`** (explicit, no gate) →
  when the spec ships → `landed → done` (gate passes). A task is **never** auto-moved — `landed` is set
  explicitly by whoever finishes the work (the coordinator's bookkeeping), exactly like any other status.
- **`ready_to_close` attention** (TaskStore.ts ~427): change the trigger from `active + sdd shipped` to
  **`landed + sdd shipped`** — the landed task whose gating spec has now shipped is the one to close. (Drop the
  `active + shipped` case; a shipped-spec active task is unusual and not the target.)
- **`next_task`** (src/tasks/nextTask.ts ~28): **exclude `landed`** from the workable candidate pool (add it
  next to `inbox`/`done`/`dropped` in the skip). Landed is done-ish, never offered as next work.
- **Dependency satisfaction** (nextTask.ts ~87): **conservative — `landed` does NOT satisfy a dependency**
  (only `done`/`dropped` do). A dependent task waits until the landed task fully closes. (Decision: the gating
  spec means the feature isn't finally validated; revisit if it bites.)

## Ripple checklist (exhaustive `TaskStatus` sites — codex must cover ALL)

`TaskStatus` is switched/labelled/colored/serialized across ~30 files. Every exhaustive switch or status→X map
MUST handle `landed`:
- **Board:** boardModel.ts (column + label `Landed`), boardSnapshot.ts (`allowedDropStatuses` follows the new
  transitions), mission-control/App.tsx + messages.ts (render + drag), MissionControlPanel.ts.
- **Plugin projection:** src/plugins/ui/projectionBuilder.ts — the pseudonymized coarse status vocabulary must
  include `landed` (keep it leak-free; `landed` is a non-sensitive status). Do not break the canary test.
- **Sidebar / studios / detail:** sidebar/actions.ts + types.ts, webview/sidebar + SidebarPrototype, studioModel.ts,
  TaskStudioAdapter/Panel, task-detail/messages.ts — status labels/colors/pickers.
- **Pipeline / probes / continuity:** pipelineDriver.ts, PipelineManager.ts, probe/taxonomy.ts + probeView.ts,
  ContinuityStore.ts — anywhere a status is enumerated.
- **l10n:** the `Landed` column label + any status label needs a pt-BR entry (the pre-commit i18n gate WILL
  block a missing pt-BR). Label wording: keep `Landed` as the English column label (consistent with the other
  English board labels); pt-BR suggestion "Aguardando spec" or "Concluído (aguardando spec)" — codex proposes,
  maintainer can retune.

## Remove (the t-82f870 derive-only machinery)

- boardModel.ts: `gatedLanded` field on `BoardCardVM`, `isGatedLanded`, `SDD_DONE_GATE_STATUSES`.
- boardSnapshot.ts: `liveAgents` on `BoardSnapshot`/`BoardSnapshotInput` + the derivation (added ONLY for the
  split; no other consumer). MissionControlPanel.ts: the `liveAgents` plumbing.
- mission-control/App.tsx: the in-`active`-column split (`activeLanded`/`activeInProgress`/`splitActive` + the
  grouped render). mission-control.css: `.active-group-label`, `.card.gated-landed`, `.landed-marker`.
- Replace with: `landed` as an ordinary 5th column. Optional subtle **muted** styling on landed cards so the
  column reads calm/parked (keep the per-card sdd badge).

## Migration (NOT the codex's job — coordinator handles post-deploy)

The ~10 current gated-active tasks (t-03870f, t-4c4de4, t-24f87c, t-1115bb, t-3de95a, t-ec04e4, t-e0895a,
t-fc9fc2, t-51fed6, t-ee7d5f-if-landed) are moved `active → landed` by the coordinator via `update_task` AFTER
the code ships. Existing `active` task JSON still loads (active stays valid). No data migration in code.

## Tests

- TaskStore: `active→landed` ok; `landed→done` blocked while sdd gating, allowed when shipped/absent;
  `landed→active` ok; illegal transitions rejected; `allowedTransitions(landed)` correct.
- next_task: a `landed` task is never a candidate and never satisfies a dependency.
- attention: `landed + sdd shipped` → `ready_to_close`; `landed + sdd in-progress` → none.
- boardModel/boardSnapshot: `landed` column populated + ordered; derive-only fields gone; drop statuses correct.
- plugin projection: `landed` maps into the coarse status set; canary/leak-free test still green.

## Visual-QA

Screenshot the board (anchor = the current 4-column + in-Active-split from 0.55.40). After: 5 columns with
`Landed` between Active and Done, landed cards calm/muted, Active showing only genuine WIP. Judge: the column
reads as a distinct "done, waiting on spec" stage and "what's in flight" is unambiguous.

## Sources

335 (board contract — this adds a 5th column, a deliberate revision of its "4 fixed columns" resolution; dropped
stays a toggle) · t-82f870 (the derive-only predecessor, superseded) · [[honest-status-over-derive-shortcut]].
Tracking: new task (below).
