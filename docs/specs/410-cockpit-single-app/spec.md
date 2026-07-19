# 410 — cockpit-single-app

_Created 2026-07-18._

**Status:** draft

## Intent

Tachyon ships **many independent Preact webview apps** (≈23 `App.tsx` surfaces + separate
`main.tsx` mounts). Each app owns its own mount, CSS sheet(s), and page shell habits. That
multiplicity is a primary driver of **visual inconsistency**: divergent padding, header
typography, button chrome, and one-off rules (e.g. bare `button {}` under Approvals,
sticky `.ds-head` under Plugins, double pad on Control embeds). A shared component kit
(`shared/ui`, design-system tokens) exists but cannot enforce one shell when every surface
is a separate runtime.

**Done** means product UI that opens in the **editor** lives under **two** Preact apps only:

1. **`sidebar`** — unchanged in role and density (fleet tree, pins, commands). Not absorbed.
2. **`cockpit`** — single editor app: Control tabs, product panels (Board, Activity, Handoff,
   Approvals, Plugins, Runtime Ops, tmux inspector, task detail, …), and studios. One mount,
   one page shell (`PageChrome` + page-pad tokens + kit `Button`), section/router navigation.

Migration is **incremental**: foundation first (shell contract + host routing), then
**one surface at a time**. No big-bang rewrite of all 23 bundles in one PR. Standalone
webview panel entrypoints may remain temporarily as thin hosts that load cockpit+section,
then collapse as each surface is in-tree.

This matters now because free-run DS polish is whack-a-mole: every ship fights a new
surface-local shell instead of inheriting one app.

## Acceptance criteria

### Foundation (must ship before bulk migration)

- [ ] **Scenario: two-app product rule is documented and enforced for new work**
  - **Given** a contributor adds editor UI
  - **When** they open a PR after this foundation lands
  - **Then** new full-page editor surfaces are cockpit **sections** (or shared kit components),
    not a new top-level `src/webview/<name>/main.tsx` app
  - **And** a mechanical guard fails CI (or a unit fixture) if a forbidden new webview entry
    is introduced without an explicit allowlist/exception

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
  - **Then** section S is restored (or a documented default with a single migration note)
  - **And** deep-link / command open (e.g. Open Approvals, Open Board) targets cockpit+section
    for migrated surfaces

### Incremental migration (per surface — pattern)

- [ ] **Scenario: a migrated surface has one shell**
  - **Given** surface X has completed its migration task under this spec
  - **When** the human opens X via Control or the product command
  - **Then** X renders inside the cockpit Preact tree (or a thin host that only boots cockpit+X)
  - **And** X does not ship a competing page header or outer pad
  - **And** visual QA evidence is recorded (screenshot or maintainer verdict) for X vs Fleet

- [ ] **Scenario: legacy bundle removal is explicit**
  - **Given** surface X is fully in-tree and no host opens its old entry
  - **When** the migration task closes
  - **Then** the old `main.tsx`/build entry is removed or allowlisted as dead-code with a
    follow-up deletion task — no silent dual-path forever

### Static facts

- [ ] Spec + plan + tasks exist under `docs/specs/410-cockpit-single-app/`.
- [ ] Inventory of current Preact apps and host panel managers is cited in `plan.md` /
  `notes.md` (baseline ~23 `App.tsx`, separate panel managers under `src/webview/`).
- [ ] STYLEGUIDE cross-links the two-app rule and editor shell contract.
- [ ] First foundation slice has **Verify** and **Visual QA** (or explicit opt-out with reason).

## Non-goals

- Absorbing **sidebar** into cockpit.
- Rewriting all surfaces in one PR / one release.
- Replacing Preact with React, or big-bang npm shadcn adoption.
- Changing Bridge/engine protocols, agent runtime, or tachyon.yml schema (except optional
  UI-only settings if needed for default section).
- Perfect visual identity of **studio canvases** (forms/kanban body) with Fleet cards — only
  **page shell** (pad, header, button metrics) is in scope for parity; body content keeps
  domain layout.
- Mobile companion / non-VS Code shells.
- Plugin **runtime** multi-compat expansion (parallel workstream; out of scope here).

## Open questions

1. **Host strategy for intermediate migrations:** thin dedicated `WebviewPanel` that only
   loads cockpit.js+`section=X`, vs always the single Control panel instance — pick in plan;
   may differ per surface during transition.
2. **Studios:** same cockpit section router vs `StudioFrame` region still hosted as cockpit
   child routes under `/studio/*` — plan should choose one tree shape.
3. **Bundle weight:** code-split strategy (dynamic `import()` per section) vs single chunk
   for v1 foundation — plan picks a default with a size budget note.

_Human ratification: intent agreed in conversation 2026-07-18 (two apps; sidebar frozen;
rest migrates gradually after foundation)._
