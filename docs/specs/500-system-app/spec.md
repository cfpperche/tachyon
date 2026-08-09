# 500 — system-app

_Created 2026-08-09._

**Status:** shipped

**Closure:** Overview and Engine are one app, `System`. The summary derives from the same rows the
cards render, so the counter cannot contradict them; `workspaceCount` renders as an explicitly scoped
window sub-line. `overview` and `engine` still decode and resolve to `system`, so the eight default
fallbacks in `route.ts` were untouched. plan.md § D4 was cancelled mid-build: `control.workspaces` is
always 0 or 1, so the collapse rule it specified was unreachable. Merged in `eb96fd56`.

**Verify:** `npm run verify:full:quiet`

<!-- The maintainer owns the intent; this is a transcription awaiting ratification.
     The measurement in § "They are already one screen" is what shapes this spec — read it
     before proposing any layout, because it says these two are a summary and its detail. -->

## Intent

Control offers **Overview** and **Engine** as two tiles opening two standalone apps. The maintainer's
decision: they become one screen, named **System**.

### They are already one screen, measured

Both apps read the same `CockpitModel`, and Overview's numbers are read directly off the object Engine
renders row by row:

```
model.ts:529   enginesAttached: control.summary.attachedEngines
```

The two projections are built side by side in one function (`model.ts:525` and the `control` block it
sits next to). What each surface does with them:

| fact | Overview shows | Engine shows |
|---|---|---|
| engines attached / in error | two counters | per-workspace `state` badge |
| agents | `running/total`, one number | `running/total`, per workspace |
| bridge | folder, url, ok — one line each | url, port, instance, auth — per workspace |
| workspaces | a count | one card each |

**Overview is a rollup of Engine's rows.** Not a different subject — the same subject at a different
zoom. That is why this unification is not "stack two pages": it is putting a summary back on top of
the detail it summarises.

Two things Overview carries that Engine has no per-workspace equivalent for, and they are the reason
System is not simply "Engine with a header":

- `inboxPending` — `approvalsPending + validationsAwaitingHuman` (`model.ts:470`), and it is a
  **button** that navigates to the Inbox
- `worktreesActive` (`model.ts:466`)

Both are cross-cutting counts about the workspace as a whole, not about any one engine.

### What System answers

**"Is Tachyon up and healthy, and if not, where?"** The summary answers the first half at a glance;
the per-workspace detail answers "where" without a second navigation.

## Acceptance criteria

- [ ] **Scenario: one tile, one screen**
  - **Given** the Control launcher
  - **When** it is rendered
  - **Then** there is a single System tile where Overview and Engine used to be, and no route,
    manifest row, or navigation entry survives for either old section

- [ ] **Scenario: the glance still works**
  - **Given** a workspace with engines attached, agents running, and items awaiting a human
  - **When** System opens
  - **Then** every counter Overview showed is present, and the Inbox counter still navigates to the
    Inbox

- [ ] **Scenario: the detail still works**
  - **Given** the selected workspace with its engine in error
  - **When** System is read
  - **Then** it still exposes its engine, bridge and workspace facts and its log panel, and the
    failure is legible without opening anything

- [ ] **Scenario: a summary that cannot disagree with its rows**
  - **Given** any set of attached workspaces
  - **When** the summary and the rows are rendered together
  - **Then** the summary is derived from the same rows on screen, so no state exists in which the
    counter and the cards contradict each other

- [ ] **Scenario: the default route survives**
  - **Given** any entry point that falls back to a default section
  - **When** it resolves
  - **Then** it lands on a section that exists, and no nav-less state renders as if a tab were open

- [ ] The actions both pages carried — auto-refresh, refresh, copy diagnostics, open doctor — are all
      reachable, or their removal is a recorded decision rather than an omission.
- [ ] No screenshot of the old pair is needed to tell what was lost, because nothing was.

## Non-goals

- **Redesigning what the facts are.** This spec merges two surfaces; it does not add telemetry, remove
  a field, or change what `CockpitModel` computes.
- **Merging any other pair of sections.** System is Overview + Engine, and the argument for it is the
  measured summary/detail relationship above — an argument that does not transfer by analogy.
- **Reviving anything from the removed Execution graph** (`t-af240d`).
- **Changing the Control launcher's grid or its other tiles**, beyond the one tile that replaces two.

## Open questions

1. **The default-section fallback.** `"overview"` is the fallback in at least eight places in
   `src/cockpit/route.ts` (`:270`, `:277`, `:290`, `:322`, `:534`, `:602`, plus the comments at
   `:301-303`). That file argues deliberately that the default belongs at the call site, not inside
   the resolver, because "coercing null to overview inside this function would make nav-less state
   indistinguishable from" a real selection. Renaming or removing the section must answer this, not
   sed over it.
2. **Which viewId survives.** `tachyonOverview` and `tachyonEngine` are both declared standalone in
   `src/webview/surfaces.ts` (`:229`, `:233`). Reusing one id keeps a stale name in the manifest;
   minting a third orphans two. Decide and record which, and what happens to a user with the old tab
   open.
3. ~~**Density.** … one workspace may fill the viewport before the second row is visible.~~
   **Answered, and the premise was wrong.** `control.workspaces` is always 0 or 1 in production
   (`model.ts:439-440` — `selected` falls back to `workspaces[0]` and `scoped` filters by it; the
   "All workspaces" aggregate was removed by `t-72ff5a`). There is no second row. See plan.md § D4,
   cancelled.

   The density risk is real but different: a summary above **one** card, where an oversized summary
   pushes the only real content down while adding nothing. That is what Visual QA attacks.

## Prior decisions this reverses, deliberately

**SDD 485 (standalone-section-apps)** and **SDD 410 (cockpit-single-app)** decided this product's app
count, and 485 made each Control section its own standalone app. Merging two of them goes against that
direction.

It is reversed here for one reason, and the reason must survive in the code: **these two sections were
never two subjects.** One is the count of the other, computed from the same object in the same
function. 485's argument — that a section deserves its own editor tab — is not weakened by removing a
tab that was showing the same data twice.

## Visual QA

Required. This is a surface the maintainer looks at, and the risk named in Open question 3 is exactly
the kind that only appears on screen.
