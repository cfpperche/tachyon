# 410 — cockpit-single-app

_Created 2026-07-18._

**Status:** shipped

**Superseded on its app-count decision by [SDD 485](../485-standalone-section-apps/spec.md)
(2026-08-04).** What 485 reversed is narrow, and worth stating precisely so a reader does not throw
out more than was overturned: **"two Preact apps only"** is dead. Every Control section became a
standalone app that opens as its own editor tab, and `Cockpit.ts` — the single editor host this spec
built — is gone.

What SURVIVES, because 485 kept it rather than inherited it:

- **The sidebar is still the other app**, and still not absorbed. That half of "two apps" was never
  the contested half.
- **`WEBVIEW_SURFACES` as the manifest** (spec 279 + this spec's `hostKind`) is not only intact,
  it carries more: 485 added `posture` (`conform`/`extend`/`replace`), so a surface must now DECLARE
  its relationship to the shared shell and an undeclared departure fails the build.
- **The CSS co-load pattern and its parity guards** kept working through all twenty migrations and
  decided several of them.

**Why it was reversed.** One runtime was the MECHANISM this spec chose for one enforcement problem:
a shared kit cannot make peer apps consistent. 485's finding is that the mechanism and the goal are
separable — conformance can be enforced *mechanically* (a declared posture plus tests that fail the
build) without a single host, and the single host was paying a product price the enforcement never
required: one panel means one screen at a time, so a task detail could not sit beside the terminal
running it, and two projects could not show two boards.

**The cost this spec's own closure could not have predicted**, and 485's most transferable finding:
the audit above ("cross-checked `plan.md`'s full scope against the live `surfaces.ts` manifest and
found zero gaps") was correct about what surfaces DECLARE and blind to what Control RENDERED. Four
surfaces — activity, probes, project-handoff and a pin-studio route — had no launcher tile, so no
inventory built from the manifest ever listed them, and 485 discovered them only by reading the
`lazy()` calls out of Control's client. An inventory of declarations cannot see renderers. 485 turned
that into a test rather than a paragraph.

**Closure:** 2026-07-24 — Phases B–E complete (`tasks.md`): foundation guard extends `WEBVIEW_SURFACES`
(`hostKind` field) rather than a parallel manifest; every Phase B/C/D surface (Approvals, Runtime
Ops, Validations, Plugins, tmux inspector, Board, task detail/handoff/probes as subroutes, 7
studios) migrated to one host path with the old panel retired or dropped from the manifest; sidebar
stayed a separate bundle throughout; `cockpitBundleBudget.test.ts` and `webviewConvention.test.ts`
green; CSS co-load pattern (`lazySectionStyles`) landed and is enforced by
`lazySectionStyles.test.ts`/`cockpitCssParity.test.ts`; the Phase C multi-instance decision
(subroutes, not tabs) is recorded in `plan.md`'s Key decisions table; STYLEGUIDE cross-links the
two-app rule. "Did we forget anything" audit 2026-07-22 cross-checked `plan.md`'s full scope against
the live `surfaces.ts` manifest and found zero gaps (2 real drifts caught and fixed same day: dead
Approvals bundle, stale plan.md multi-instance text). Visual QA accepted via real production usage
per migrated surface (maintainer decision, 2026-07-22) — no formal Approvals-vs-Fleet A/B recorded.
Standing exceptions (not debt): sidebar (by design, the other app), pin-preview (static, out of
"full-page editor" scope), 2 dev-only spec-350 fakes, plugin surfaces (security isolation) — see
`surfaces.ts`. Full suite green throughout (469 files / 5378 tests as of the Phase E audit).
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

- [x] **Scenario: the foundation guard is the single source of truth for webview surfaces**
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

- [x] **Scenario: cockpit shell is the only page chrome for native sections**
  - **Given** cockpit is open on a **native** section (rendered in-tree, not a legacy embed)
  - **When** the section body mounts
  - **Then** the page header is `PageChrome` only: title = `--ds-title`, hint = `--ds-small`
    muted, no title icon; outer pad = `--ds-page-pad-*`
  - **And** product actions use kit `Button` / `IconButton` (`.ds-btn` single box); surface CSS
    must not redefine bare `button` or override `.ds-btn` metrics

- [x] **Scenario: sidebar remains a separate app**
  - **Given** the Tachyon sidebar webview
  - **When** the extension loads
  - **Then** it still uses the sidebar bundle and density chrome (`.act` / native hits)
  - **And** cockpit work does not require loading the sidebar into the editor panel tree

- [x] **Scenario: section navigation is durable**
  - **Given** cockpit is open on section S
  - **When** the webview is hidden/shown or the panel is restored after reload (serializer path)
  - **Then** section S is restored exactly, using the existing `CockpitPanelState.section` +
    `registerTrustedPanelSerializer` path wired for `COCKPIT_VIEW_TYPE`
  - **And** if S no longer exists (retired section), cockpit falls back to `"overview"` and this
    fallback is asserted by a unit test

- [x] **Scenario: cockpit bundle growth is gated, not just measured**
  - **Given** `dist/webview/cockpit.js` is ~244KB today and several migration targets are larger
    individually (e.g. activity ~648KB, task-detail ~644KB, handoff ~640KB)
  - **When** a surface migrates into cockpit's Preact tree
  - **Then** it is loaded via the **Phase A lazy-import** mechanism unless explicitly exempted with
    a written reason in `plan.md`
  - **And** **budget through Phase B:** initial (eager) `cockpit.js` parse payload stays
    **≤ 350 KB** uncompressed on disk (or the documented successor number if measured baseline moves);
    each migration PR records dist sizes before/after; exceeding budget without code-split is a failed gate

- [x] **Scenario: multi-instance surfaces have an explicit cockpit hosting design**
  - **Given** Task detail, Handoff, and Probes today support N concurrent panel instances
    (`Map`-keyed managers)
  - **When** Phase C proposes migrating a multi-instance surface into “a cockpit section”
  - **Then** `plan.md` states, **before any Phase C task starts**, one of: (a) cockpit gains
    multi-instance/tabbed section support; (b) the surface keeps a **documented standing exception**
    as a thin standalone host; or (c) only the single most-recent instance is supported (behavior
    change stated explicitly)
  - **And** the choice is in plan.md’s Key decisions table (not deferred to implementation start)

- [x] **Scenario: CSS co-load shrinks as sections go native**
  - **Given** cockpit today co-loads multiple product stylesheets in its shell
  - **When** a Control-family section becomes native in-tree
  - **Then** its standalone sheet is no longer unconditionally injected for all sections (only when
    that section is active, or inlined into the section module’s CSS import)
  - **And** a test or checklist item fails if a migrated section’s CSS remains in the global
    always-on co-load list without justification

### Incremental migration (per surface — pattern)

- [x] **Scenario: a migrated surface has one host path**
  - **Given** surface X has completed its migration task under this spec
  - **When** the human opens X via Control or the product command
  - **Then** X renders inside the cockpit Preact tree (or a documented thin host / multi-instance
    exception)
  - **And** the previous dual command path (standalone panel **and** cockpit section) is removed or
    redirected to a single entry
  - **And** `WEBVIEW_SURFACES` + convention tests reflect the new host
  - **And** visual QA evidence is recorded for page **shell** vs Fleet (pad, title, buttons)

- [x] **Scenario: legacy bundle removal is explicit**
  - **Given** surface X is fully in-tree and no host opens its old entry
  - **When** the migration task closes
  - **Then** the old `main.tsx`/build entry is removed or marked retired on `WEBVIEW_SURFACES` with
    a follow-up deletion — no silent dual-path forever

### Static facts

- [x] Spec + plan + tasks under `docs/specs/410-cockpit-single-app/`.
- [x] Inventory cites spec 279 `WEBVIEW_SURFACES` + App.tsx counts; Approvals dual path noted.
- [x] STYLEGUIDE cross-links the two-app rule.
- [x] Foundation has **Verify** including `webviewConvention.test.ts`.
- [x] Fable review folded (`docs/reviews/cockpit-single-app-410-fable.md`).

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
