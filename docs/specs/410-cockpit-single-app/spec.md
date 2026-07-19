# 410 — cockpit-single-app

_Created 2026-07-18._

**Status:** draft
<!-- Updated 2026-07-19: fable ACCEPT-WITH-CHANGES — P0s folded (surfaces.ts guard, multi-instance, bundle budget). -->

## Intent

Tachyon ships **many independent Preact webview apps** (23 `App.tsx` under `src/webview/`, 24
`main.tsx` mounts — `plugin-host` serves two `viewId`s). Each app owns its own mount, CSS sheet(s),
and host panel manager. That multiplicity drives **structural** inconsistency: dual command routes,
CSS co-load bleed into Control, dual pad on embeds, and surface-local shell overrides — even after
STYLEGUIDE chrome adoption (spec 282 / free-run DS) improved many headers.

A shared kit (`shared/ui`, design-system tokens) cannot enforce one runtime when every surface is a
peer app. **Done** means editor product UI lives under **two** Preact apps only:

1. **`sidebar`** — unchanged role and density. Not absorbed.
2. **`cockpit`** — single editor app for Control sections, product panels, and studios. One primary
   mount, one page shell (`PageChrome` + `--ds-page-pad-*` + kit `Button`), section navigation on
   `CockpitSectionId` (no second router).

Migration is **incremental**: foundation first (extend **spec 279** `WEBVIEW_SURFACES`, shell
wrapper, lazy-import mechanism, bundle budget, one pilot), then **one surface per PR**. No big-bang.

This is primarily an **architecture** fix (one runtime, one host path, one CSS graph over time), not
a re-do of already-marked STYLEGUIDE chrome pilots — those remain the visual baseline (Fleet).

## Acceptance criteria

### Foundation (must ship before bulk migration)

- [ ] **Scenario: the foundation guard is the single source of truth for webview surfaces**
  - **Given** `src/webview/surfaces.ts` (`WEBVIEW_SURFACES`, spec 279) and
    `test/unit/webviewConvention.test.ts` already enforce `main.tsx` / esbuild entry / serializer
    coverage for every registered webview surface
  - **When** Phase A adds a mechanical guard for the two-app rule
  - **Then** the guard **extends** `WEBVIEW_SURFACES` (e.g. `cockpitSectionOnly` /
    `retiredInFavorOf: "cockpit"` / host strategy fields) rather than introducing an independent
    manifest or snapshot list
  - **And** any task that deletes a `main.tsx` or Panel manager updates `WEBVIEW_SURFACES` (and its
    converted / reload-serializer expectations) **in the same PR**, verified by
    `webviewConvention.test.ts` staying green
  - **And** `MIGRATED_VIEWS` (spec 282) is updated in the same PR when a migrated view directory is
    removed or renamed

- [ ] **Scenario: cockpit shell is the only page chrome for native sections**
  - **Given** cockpit is open on a **native** section (rendered in-tree, not a legacy embed)
  - **When** the section body mounts
  - **Then** the page header is `PageChrome` only: title = `--ds-title`, hint = `--ds-small`
    muted, no title icon; outer pad = `--ds-page-pad-*`
  - **And** product actions use kit `Button` / `IconButton` (`.ds-btn` single box); surface CSS
    must not redefine bare `button` or override `.ds-btn` metrics

- [ ] **Scenario: sidebar remains a separate app**
  - **Given** the Tachyon sidebar webview
  - **When** the extension loads
  - **Then** it still uses the sidebar bundle and density chrome (`.act` / native hits)
  - **And** cockpit work does not require loading the sidebar into the editor panel tree

- [ ] **Scenario: section navigation is durable**
  - **Given** cockpit is open on section S
  - **When** the webview is hidden/shown or the panel is restored after reload (serializer path)
  - **Then** section S is restored exactly, using the existing `CockpitPanelState.section` +
    `registerTrustedPanelSerializer` path wired for `COCKPIT_VIEW_TYPE`
  - **And** if S no longer exists (retired section), cockpit falls back to `"overview"` and this
    fallback is asserted by a unit test

- [ ] **Scenario: cockpit bundle growth is gated, not just measured**
  - **Given** `dist/webview/cockpit.js` is ~244KB today and several migration targets are larger
    individually (e.g. activity ~648KB, task-detail ~644KB, handoff ~640KB)
  - **When** a surface migrates into cockpit's Preact tree
  - **Then** it is loaded via the **Phase A lazy-import** mechanism unless explicitly exempted with
    a written reason in `plan.md`
  - **And** **budget through Phase B:** initial (eager) `cockpit.js` parse payload stays
    **≤ 350 KB** uncompressed on disk (or the documented successor number if measured baseline moves);
    each migration PR records dist sizes before/after; exceeding budget without code-split is a failed gate

- [ ] **Scenario: multi-instance surfaces have an explicit cockpit hosting design**
  - **Given** Task detail, Handoff, and Probes today support N concurrent panel instances
    (`Map`-keyed managers)
  - **When** Phase C proposes migrating a multi-instance surface into “a cockpit section”
  - **Then** `plan.md` states, **before any Phase C task starts**, one of: (a) cockpit gains
    multi-instance/tabbed section support; (b) the surface keeps a **documented standing exception**
    as a thin standalone host; or (c) only the single most-recent instance is supported (behavior
    change stated explicitly)
  - **And** the choice is in plan.md’s Key decisions table (not deferred to implementation start)

- [ ] **Scenario: CSS co-load shrinks as sections go native**
  - **Given** cockpit today co-loads multiple product stylesheets in its shell
  - **When** a Control-family section becomes native in-tree
  - **Then** its standalone sheet is no longer unconditionally injected for all sections (only when
    that section is active, or inlined into the section module’s CSS import)
  - **And** a test or checklist item fails if a migrated section’s CSS remains in the global
    always-on co-load list without justification

### Incremental migration (per surface — pattern)

- [ ] **Scenario: a migrated surface has one host path**
  - **Given** surface X has completed its migration task under this spec
  - **When** the human opens X via Control or the product command
  - **Then** X renders inside the cockpit Preact tree (or a documented thin host / multi-instance
    exception)
  - **And** the previous dual command path (standalone panel **and** cockpit section) is removed or
    redirected to a single entry
  - **And** `WEBVIEW_SURFACES` + convention tests reflect the new host
  - **And** visual QA evidence is recorded for page **shell** vs Fleet (pad, title, buttons)

- [ ] **Scenario: legacy bundle removal is explicit**
  - **Given** surface X is fully in-tree and no host opens its old entry
  - **When** the migration task closes
  - **Then** the old `main.tsx`/build entry is removed or marked retired on `WEBVIEW_SURFACES` with
    a follow-up deletion — no silent dual-path forever

### Static facts

- [ ] Spec + plan + tasks under `docs/specs/410-cockpit-single-app/`.
- [ ] Inventory cites spec 279 `WEBVIEW_SURFACES` + App.tsx counts; Approvals dual path noted.
- [ ] STYLEGUIDE cross-links the two-app rule.
- [ ] Foundation has **Verify** including `webviewConvention.test.ts`.
- [ ] Fable review folded (`docs/reviews/cockpit-single-app-410-fable.md`).

## Non-goals

- Absorbing **sidebar** into cockpit.
- Rewriting all surfaces in one PR / one release.
- Replacing Preact with React, or big-bang npm shadcn adoption.
- Re-litigating STYLEGUIDE chrome already marked done — shell **enforcement via one runtime** is the goal.
- Perfect visual identity of studio/kanban **bodies** with Fleet cards — only page shell metrics.
- Changing Bridge/engine protocols or plugin **runtime** multi-compat (parallel workstream).
- Mobile / non-VS Code shells.

## Open questions

1. **Host strategy for intermediate migrations** — thin dedicated `WebviewPanel` that boots
   cockpit+section vs always the single Control panel instance. **Decision criteria:** prefer single
   Control panel when the surface is already a Control tab; thin host only when VS Code UX requires a
   separate editor tab *and* multi-instance is not chosen. Finalize per surface in the migration PR.
2. **Studios tree shape** — `StudioFrame` as child routes under cockpit (`studio/*`). Default: yes.
3. **Bundle budget successor** — if 350 KB proves wrong after pilot measurement, update plan.md number
   in the same PR as the measurement; do not drop the gate.

_Human ratification: two-app intent 2026-07-18. Fable review ACCEPT-WITH-CHANGES 2026-07-19._
