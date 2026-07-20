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

### Phase C — Multi-instance class (blocked until decision)

**Key decision (architecture — pick before any Phase C code):**

| Option | Meaning |
|--------|---------|
| **B (default recommendation)** | Task detail, Handoff, Probes remain **thin standalone hosts** (multi-instance `Map` managers stay). They may share kit/shell components via imports but are **not** cockpit singleton sections. Mark `editorHome: "standalone"` + exception note. |
| A | Cockpit grows multi-instance / multi-tab section support (large design). |
| C | Singleton-only (regress N concurrent panels) — only if product explicitly accepts. |

**Override (maintainer, 2026-07-20, t-610705): Option B is a SEQUENCING choice, not a permanent
exception.** Task Detail / Handoff / Probes stay thin standalone hosts through Phase B/C so the
Control-family migration isn't blocked on the harder multi-instance design, but they are NOT
exempt from the two-app rule long-term — Option A (cockpit grows multi-instance/multi-tab section
support) is the eventual target. Mark `editorHome: "standalone"` with an explicit
`retiredInFavorOf`-style forward note (not a bare "exception"), and open the Option A design once
Phase B's single-instance surfaces are done.

Phase C (as originally scoped, now the INTERIM step): extract shared bodies, align shell chrome,
optionally deep-link "open in cockpit" without killing multi-instance panels.
Phase C.5 (new, added by the override): design + implement Option A — cockpit multi-instance
section support — then migrate Task Detail / Handoff / Probes onto it, closing the exception.

### Phase D — Studios

- Lazy routes under cockpit; `StudioFrame` preserved.
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
