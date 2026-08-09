# 367 - Runtime Ops panel

_Created 2026-07-09._

**Status:** shipped
**Closure:** 2026-07-12 — Runtime Ops panel (phases 1–4) + global `npm run test:browser` restored via `t-1c745f` (57/57). Earlier shipped-partial held only on out-of-slice browser debt.

**Verify:** `npm run verify:full`
**Dogfood:** `xvfb-run -a npx vscode-test --label single-root --run test/integration/runtimeOps.test.js`

## Intent

The `$(pulse) Usage` status-bar control currently opens a transient QuickPick built from PATH detection,
durable activity logs, and current rate-limit attention. It is honest but too shallow for operating a
multi-runtime agent fleet: it does not preserve context, correlate runtime-level usage with live agents, or
show whether a session can resume and its Bridge client is bound to the current host generation.

Introduce a first-class Runtime Ops view in the VS Code bottom panel. The view is a compact, read-only
operational surface organized by runtime, with per-agent detail where the source data supports it. The existing
status-bar command becomes the stable entry point that opens and focuses this panel. Every displayed value must
carry a known local source or an explicit unavailable reason; the UI must never synthesize vendor usage,
context pressure, runtime version, or Bridge health.

## Acceptance criteria

- [x] **Scenario: Open Runtime Ops from the status bar**
  - **Given** at least one configured Tachyon workspace is open
  - **When** the user activates the Runtime status-bar item or runs `Tachyon: Show Runtime Usage`
  - **Then** VS Code reveals and focuses the Runtime Ops view in the bottom panel without opening a QuickPick
- [x] **Scenario: Render an honest runtime inventory**
  - **Given** supported CLIs are PATH-detected and Tachyon has a mixture of live, stopped, and throttled agents
  - **When** Runtime Ops builds a snapshot
  - **Then** it renders one deterministic row per detected or Tachyon-managed runtime with sourced usage,
    agent counts, attention, model, session readiness, Bridge state, last activity, and observed version where known
- [x] **Scenario: Explain unavailable data**
  - **Given** a runtime has no normalized usage, context-window limit, observed version, or Bridge binding
  - **When** its row is rendered
  - **Then** the field says unavailable or not wired and exposes a concise source-specific reason instead of zero,
    an estimate, or a success state
- [x] **Scenario: Keep terminal text out of throttle summaries**
  - **Given** a throttled attention record contains a free-form matched terminal line
  - **When** Runtime Ops projects the throttle
  - **Then** it renders only the normalized runtime, scope, and reset time plus a fixed fallback message, never the raw
    matched line
- [x] **Scenario: Refresh only when useful**
  - **Given** the Runtime Ops view is hidden
  - **When** fleet and activity state changes
  - **Then** the provider does not run a background UI polling loop, and the next reveal publishes a fresh snapshot
- [x] **Scenario: Keep the visible panel current**
  - **Given** the Runtime Ops view is visible
  - **When** agent lifecycle, attention, Bridge generation, workspace membership, or normalized activity changes
  - **Then** a coalesced refresh updates the affected rows and a manual refresh remains available
- [x] **Scenario: Reset stale Bridge state on a new agent incarnation**
  - **Given** an agent name was cancelled during rebind and later starts, restarts, or resumes as a new process
  - **When** Runtime Ops reads Bridge health for the new incarnation
  - **Then** the old `cancelled` state cannot survive as the new process state; an unreset or unmapped cancellation is
    shown as unknown with a reason, never healthy or failed
- [x] **Scenario: Work in narrow and wide placements**
  - **Given** the user resizes the panel or drags the view to a sidebar
  - **When** available width crosses the compact breakpoint
  - **Then** the dense table reflows into scan-friendly runtime rows without clipped controls, overlapping text, or
    horizontal page scrolling
- [x] Runtime Ops is a statically contributed `WebviewView` inside a custom `viewsContainers.panel` container,
  not an editor `WebviewPanel`, TreeView, OutputChannel, or Terminal
- [x] The v1 projection is read-only except for refresh and existing non-destructive navigation; it does not expose
  agent lifecycle, authentication, or vendor-account mutation actions
- [x] Multi-root snapshots preserve workspace provenance for every agent, do not merge same-named agents, and visibly
  disambiguate duplicate workspace basenames with the shortest unique parent-path suffix
- [x] Pure projection tests cover cumulative versus delta usage, unavailable reasons, throttles, Bridge generations,
  cancellation/new-incarnation reset, resumability, multi-root collisions, and deterministic ordering
- [x] Provider tests prove no provider-owned interval is registered and hidden views receive no refresh callback until
  reveal, using fake timers and injected refresh/detection sources
- [x] Browser and real VS Code visual proof cover empty, mixed, throttled, stale Bridge, wide panel, and narrow view states

## Non-goals

- Query vendor billing or quota APIs, scrape account dashboards, or claim parity with ccusage
- Add real-time network polling or run blocking vendor probes whenever the panel opens
- Derive context-window pressure from cumulative token usage without a normalized context limit
- Treat PATH presence as proof that a CLI is authenticated or healthy
- Replace Mission Control, Activity, the Tachyon sidebar, or the raw agent terminal
- Add destructive agent, Bridge, credential, or runtime-management actions in v1
- Provide historical charts, cost accounting, budgets, alerts, or cross-machine aggregation
- Create implementation backlog cards before this design is accepted

## Ratified decisions

Maintainer ratified all four decisions on 2026-07-09:

- **Visible naming:** panel title `Runtime Ops`; status-bar label `$(pulse) Runtime`.
- **Compatibility command:** keep `tachyon.showRuntimeUsage`, retarget it from QuickPick to the panel, and remove the
  QuickPick only after feature parity.
- **V1 interaction boundary:** read-only plus refresh; opening agent terminals and operational mutations are deferred
  until after dogfood.
- **Information architecture:** one dense runtime table with expandable agent detail; at narrow widths each row
  reflows into a labeled detail grid instead of splitting Runtime and Agents into separate views.

**Closure:** Shipped the Runtime Ops panel, compatibility command redirect, honest runtime/agent projection, event-driven
refresh behavior, responsive wide/narrow layouts, focused browser/VS Code proof, and installed VSIX bottom-panel/sidebar
dogfood. Repository-wide browser verification remains partial because of seven unrelated failures tracked by follow-up
task `t-1c745f`.
