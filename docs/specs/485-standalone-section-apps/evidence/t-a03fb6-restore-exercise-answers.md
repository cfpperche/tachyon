# t-a03fb6 / SDD 485 D21 — restore exercise (observed answers)

**Agent:** d16restore · **When:** 2026-08-05 · **Tree:** worktree `d16restore` · **Host:** Dev Host headless-interactive, VS Code 1.128.0, fixture `agent-studio-canonical-dogfood` (seeded `t-restore-a`/`t-restore-b`, `p-restore-a`/`p-restore-b`).

**Method:** Reused reload-crossing from `scripts/dev-host/scenarios/t-5fc17d-reload-traversal.mjs` (planted `window` marker → `Developer: Reload Window` → marker gone + workbench still CDP-drivable). Opening used a **temporary** measurement command (open all managers across `workbench.action.newGroupRight` + dump `openKeys`/`tabGroups` to `.tachyon/restore-exercise-*.json`); that product instrumentation was **removed after capture**. Scenario retained: `scripts/dev-host/scenarios/t-a03fb6-restore-exercise.mjs`. Full structured dump: `t-a03fb6-restore-exercise-evidence.json` (same folder). Screenshots under `.tachyon/dev-host/interactive-out-a03fb6/` (local run outdir, not committed).

**Reload fact:** marker planted before reload; after reload value was `"<gone>"`; extension host PID restarted; workbench still answered CDP. This confirms the t-5fc17d finding: the harness crosses reload; earlier “EDH dies” was a wrong PID observation.

---

## Q1 — Do all apps return after reload?

**Answer: YES (observed)**

| | pre | post |
|---|---:|---:|
| tabs (DOM + dump) | 23 | 23 |
| editor groups | 24 | 24 |
| manager keys (flat) | 22 | 22 |
| missing keys | — | **[]** |

**Full pre key list (authoritative `openKeys`):**

- `overview::tachyonOverview|c9344e51`
- `fleet::tachyonFleet|c9344e51`
- `humanInbox::tachyonHumanInbox|c9344e51`
- `board::tachyonBoard|c9344e51`
- `worktrees::tachyonWorktrees|c9344e51`
- `executionGraph::tachyonExecutionGraph|c9344e51`
- `runtimeOps::tachyonRuntimeOps`
- `runtimeConfig::tachyonRuntimeConfig|c9344e51`
- `tmux::tachyonServerInspector`
- `plugins::tachyonPlugins|c9344e51`
- `settings::tachyonSettings|c9344e51`
- `taskDetail::tachyonTaskDetail|c9344e51|t-restore-a`
- `taskDetail::tachyonTaskDetail|c9344e51|t-restore-b`
- `pinDetail::tachyonPinPreview|c9344e51|p-restore-a`
- `pinDetail::tachyonPinPreview|c9344e51|p-restore-b`
- `agentStudio::tachyonAgentStudioShell|c9344e51|new`
- `commandStudio::tachyonCommandStudioShell|c9344e51|new`
- `terminalStudio::tachyonTerminalStudioShell|c9344e51|new`
- `runbookStudio::tachyonRunbookStudioShell|c9344e51|new`
- `scheduleStudio::tachyonScheduleStudioShell|c9344e51|new`
- `handoff::tachyonHandoff|c9344e51`
- `probes::tachyonProbes|c9344e51|workspace`

**Post keys:** identical list (same project hash `c9344e51`, same identities).

**DOM tab labels pre → post (23 tabs):** every launcher title returned in the same group slot. Studio titles refreshed from “New Agent” etc. to “agent — new” etc. after reload (title recompute, not identity swap — keys still `|new`).

**Not in the open set:**

- **Activity** — fixture roster is empty; Activity is `document` keyed by agent. Not opened; not claimed.
- **Engine** — VS Code tab `Engine` with `viewType: tachyonEngine` was present pre and post in viewColumn 3, so the **panel restored**. `EnginePanelManager` has no `openKeys` getter, so the dump listed `engine:[]` both sides; that is instrumentation, not a missing tab. No product bug filed.

---

## Q2 — Do documents return to the SAME entity?

**Answer: YES (observed)**

| identity | pre key | post key | pre DOM label | post DOM label |
|---|---|---|---|---|
| `t-restore-a` | yes | yes | `Task t-restore-a` (group 14) | same |
| `t-restore-b` | yes | yes | `Task t-restore-b` (group 15) | same |
| `p-restore-a` | yes | yes | `Pin — p-restore-a` (group 16) | same |
| `p-restore-b` | yes | yes | `Pin — p-restore-b` (group 17) | same |

No swap: each identity appears once post-reload under its own key. Studios remained on identity `new` (provisional create identity).

---

## Q3 — Does cardinality survive restore?

**Answer: YES (observed)**

- **Dashboards** (overview, fleet, humanInbox, board, worktrees, executionGraph, runtimeConfig, plugins, settings, handoff): **1 panel each** pre and post for project `c9344e51`.
- **Windows** (tmux / Server Inspector, runtimeOps): **exactly one** each; keys carry **no project** (`tachyonServerInspector`, `tachyonRuntimeOps`).
- **Documents:** task and pin identities each appear **once**; studios one each at `|new`; probes one at `|workspace`.
- **Refuse-without-identity** was not re-driven through a bad UI door this round (same as the earlier pre-reload note): cardinality of *open* panels matches the declared shape; no duplicate revive observed.

---

## Q4 — Does position across editor groups survive?

**Answer: YES (observed)**

- pre/post **groupCount = 24**
- Sampled key tabs (Board, Fleet, Engine, tmux, Plugins, both tasks, both pins): **viewColumn identical pre and post** (e.g. Board col 6, Fleet col 4, Task t-restore-a col 14, …).

Full `groupMap` is in the JSON evidence.

---

## Q5 — Pending draft vs reload (confirmation only)

Maintainer decision (journal 2026-08-04): draft need not survive window reload. Prior restoreapp round observed Agent Studio draft `UNSAVED-RESTORE-DRAFT` die with the process. This round did not re-seed a draft; reload still kills the extension host (new PID after reload in console.log). **Behaviour matches the declared process-lifetime draft model.** Not a defect.

---

## SDD 485 acceptance criterion

**Scenario: reload restores what was open** — **verified** by this exercise (D21 / t-a03fb6). Marked in `tasks.md` and `spec.md`. Remaining open acceptance on 485 is the error-boundary criterion (t-cd01bb / t-4a3333 family), not restore.

---

## Product defects found

**None** that failed Q1–Q4. No `create_task` bug filed from this exercise.

---

## Residual notes

1. Temporary open/dump commands were removed from `src/extension.ts` / `package.json` after measurement (same hygiene as the earlier restoreapp round).
2. `EnginePanelManager` lacking `openKeys` is a small instrumentation gap if a future exercise wants key-level proof for Engine; the tab itself restored via VS Code serializers.
3. Activity restore still unmeasured at agent-identity count (needs a non-empty roster).
