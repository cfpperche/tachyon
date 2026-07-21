# 410 — cockpit-single-app — plan

_Drafted 2026-07-18. **Revised 2026-07-19** after fable review (ACCEPT-WITH-CHANGES)._

## Approach

Treat **one editor runtime** as the consistency mechanism. Surfaces become sections (or documented
exceptions), not peer apps.

```
Today                         Target
-----                         ------
sidebar App  ─────────────►  sidebar App  (unchanged)
cockpit App  ─┬─ embeds ──►  cockpit App
activity App ─┤                 ├─ shell + lazy section loader
approval App ─┤                 ├─ sections/* (in-tree)
… N Panel managers ────────►  WEBVIEW_SURFACES.retiredInFavorOf / thin hosts
```

### Phase A — Foundation

1. **Extend spec 279, do not fork a fourth list**
   - Add fields on `WebviewSurface` (names exact at impl time), e.g.:
     - `editorHome?: "standalone" | "cockpit-section" | "cockpit-thin-host" | "sidebar" | "dev-only"`
     - `cockpitSectionId?: CockpitSectionId | string`
     - `retiredInFavorOf?: "cockpit" | viewId`
   - Update `webviewConvention.test.ts` expectations in the **same** PRs that retire hosts.
   - When directories vanish, update spec 282 `MIGRATED_VIEWS` in the same PR.
   - **Do not** add `cockpitAppInventory.test.ts` as a parallel snapshot.

2. **Section module + shell wrapper**
   - `Body` wrapped by shell (`PageChrome` + page pad) unless `chrome: "none"`.
   - **Lazy loader in Phase A** (not deferred to Phase D): dynamic `import()` per section id so
     Phase B/C cannot merge a 600KB surface into the eager chunk by accident.

3. **Bundle budget (numeric)**
   - Baseline: `cockpit.js` ~**244 KB** (measured at review).
   - **Gate through Phase B:** eager/initial `dist/webview/cockpit.js` **≤ 350 KB** uncompressed
     (js file size on disk after production build). Over budget without split → failed PR.
   - Each migration PR: note before/after sizes in the PR or `notes.md`.
   - Lazy chunks: no single lazy chunk policy beyond “must not be forced into eager entry”; optional
     follow-up CI on total download if needed.

4. **Host routing**
   - `openCockpit({ section })` for native sections; legacy panel only while
     `editorHome === "standalone"`.
   - Serializer: restore `section`; unknown → `"overview"` + unit test.

5. **Pilot surface (named)**
   - **Approvals**
   - Why: smallest clear product panel; already shares `messages`/`viewModel` imports with cockpit;
     standalone `tachyon.openApprovals` **and** cockpit `"approvals"` section are a real dual path
     today — fixing it proves host unification, not just chrome polish; historically worst shell CSS.

6. **CSS co-load**
   - Pilot PR removes unconditional injection of the pilot’s sheet from the always-on cockpit shell
     list (load with section module instead).
   - Each Phase B PR repeats for that surface.

### Phase B — Control-family (one PR each)

| Order | Surface | Notes |
|------:|---------|--------|
| 1 | Approvals | Pilot if not fully done in A; kill `ApprovalPanel` dual open |
| 2 | Runtime Ops | |
| 3 | Validations | |
| 4 | Plugins | |
| 5 | tmux inspector | |
| 6 | Board (mission) | Already partially wired (`missionWsHash`); shell-only kanban body |
| 7 | Overview/Engine/Fleet/Worktrees/Deliveries/Settings | Shell-only audit |

Each PR DoD: lazy section; `WEBVIEW_SURFACES` update; convention + kit tests green; CSS co-load
shrink; visual QA shell vs Fleet; size note vs 350 KB eager budget.

### Phase C — Subroutes (SUPERSEDES the multi-instance decision — maintainer mandate, 2026-07-21)

**Mandate (maintainer, 2026-07-21, t-610705): ALL screens open inside Control, as subroutes.**
The earlier Option A/B/C framing and the 2026-07-20 override (Option B as sequencing, Option A as
eventual target) are both superseded: instead of the cockpit growing multi-instance/multi-tab
support, it grows an **internal router** (SPA model — Linear-style: board == task list; task
detail / edit / new are subroutes of the board). Concurrent side-by-side instances of the same
screen class are knowingly traded for the coherent single app (former Option C's regression,
explicitly accepted by product).

**C.0 — Router (prerequisite for every group):**
route = `{section, subroute, params}`; persisted panel state + revive carries the full route;
deep links via `openCockpit({route})` with the `tachyon.*` open-commands becoming redirects;
back navigation/breadcrumb in the shell chrome (e.g. `Board → t-8f86e2 → edit`). Design hardened
in an adversarial dueto before implementation.

**Migration groups (one PR each, visual pass each):**

| Group | Surfaces | Routes |
|-------|----------|--------|
| C.1 Board | Task Detail, Task Studio (new/edit) | `mission/task/<id>`, `mission/task/new`, `mission/task/<id>/edit` |
| C.2 Fleet | Activity, Probes (per-agent) | `fleet/agent/<name>/activity`, `fleet/agent/<name>/probes` |
| C.3 Handoff | Handoff (global per-workspace dashboard) | own section `handoff` |
| C.4 Pins | Pin Studio | nav-less route (`pins/<id>/edit` style) — opens Control directly, no nav entry |

**Standing exceptions (maintainer-approved, not debt):**
- Plugin surfaces (spec 349) stay OUT of Control — third-party iframe isolation is a security
  boundary, not a convenience choice.
- Dev-only fakes (pipeline-studio, agent-fixture-studio; spec 350 studio-shell scaffolding) stay
  as-is — never registered in production.

### Phase D — Studios

- The 5 studio shells (Agent/Terminal/Command/Runbook/Schedule) become routes on the Phase C
  router (`fleet/agent/new` etc.); `StudioFrame` preserved.
- Same `WEBVIEW_SURFACES` retirement discipline.

### Phase E — Cleanup

- Delete dead bundles; shrink manifests; optional cookbook.

## Key decisions

| Decision | Choice | Rejected |
|----------|--------|----------|
| App count | **2** (sidebar + cockpit) | 1 mega-app; keep N peers |
| Sidebar | Frozen separate | Merge |
| Guard | **Extend `WEBVIEW_SURFACES` (279)** | New inventory snapshot |
| Kit guard | Keep `MIGRATED_VIEWS` (282); update on delete | Ignore |
| Pilot | **Approvals** | TBD at kickoff |
| Lazy import | **Phase A mechanism** | Lazy only for studios |
| Eager budget | **≤ 350 KB cockpit.js through Phase B** | Measure-only |
| Multi-instance (task/handoff/probes) | **Standing thin-host exception (B)** until human picks A | Silent singleton |
| Migration | Foundation → PR-per-surface | Big-bang |
| Dual Approvals path | Close in pilot/B1 | Leave forever |

## Files / areas (foundation)

| Area | Paths |
|------|--------|
| Manifest | `src/webview/surfaces.ts`, `test/unit/webviewConvention.test.ts` |
| Kit list | `test/unit/webviewComponentKit.test.ts` (`MIGRATED_VIEWS`) |
| Model / nav | `src/cockpit/model.ts`, `src/webview/cockpit/*` |
| Host | `src/webview/Cockpit.ts`, `ApprovalPanel.ts`, open commands |
| Shell / DS | `shared/ui`, `design-system.css`, `STYLEGUIDE.md` |
| Pilot | `src/webview/approval/*` |

## Risks

| Risk | Mitigation |
|------|------------|
| Second inventory list | P0-1: only extend 279 |
| Bundle bloat | P0-3: lazy A + 350 KB gate |
| Multi-instance footgun | P0-2: default exception B |
| CSS co-load bleed | Per-migration unload from global shell |
| Serializer | overview fallback + test |
| Dual open Approvals | Pilot DoD |
| Parallel plugin-runtime work | Non-goal; no engine touch |

## Sources consulted

- Fable review: `docs/reviews/cockpit-single-app-410-fable.md`
- `src/webview/surfaces.ts` (spec 279), `webviewConvention.test.ts`
- `Cockpit.ts` singleton panel; TaskDetail/Handoff/Probe Map managers
- Dist sizes at review time (cockpit ~244KB; activity/task-detail/handoff ~640KB+)
- STYLEGUIDE pilot status; DS free-run 0.56.61–71
- SDD skill / conversation 2026-07-18–19

## Visual risk

High per migrated surface. Gate = shell vs Fleet. Multi-instance exceptions still use kit buttons /
PageChrome when they show a page header.
