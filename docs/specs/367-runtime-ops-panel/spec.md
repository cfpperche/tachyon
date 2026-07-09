# 367 - Runtime Ops panel

_Created 2026-07-09._

**Status:** draft

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

- [ ] **Scenario: Open Runtime Ops from the status bar**
  - **Given** at least one configured Tachyon workspace is open
  - **When** the user activates the Runtime status-bar item or runs `Tachyon: Show Runtime Usage`
  - **Then** VS Code reveals and focuses the Runtime Ops view in the bottom panel without opening a QuickPick
- [ ] **Scenario: Render an honest runtime inventory**
  - **Given** supported CLIs are PATH-detected and Tachyon has a mixture of live, stopped, and throttled agents
  - **When** Runtime Ops builds a snapshot
  - **Then** it renders one deterministic row per detected or Tachyon-managed runtime with sourced usage,
    agent counts, attention, model, session readiness, Bridge state, last activity, and observed version where known
- [ ] **Scenario: Explain unavailable data**
  - **Given** a runtime has no normalized usage, context-window limit, observed version, or Bridge binding
  - **When** its row is rendered
  - **Then** the field says unavailable or not wired and exposes a concise source-specific reason instead of zero,
    an estimate, or a success state
- [ ] **Scenario: Keep terminal text out of throttle summaries**
  - **Given** a throttled attention record contains a free-form matched terminal line
  - **When** Runtime Ops projects the throttle
  - **Then** it renders only the normalized runtime, scope, and reset time plus a fixed fallback message, never the raw
    matched line
- [ ] **Scenario: Refresh only when useful**
  - **Given** the Runtime Ops view is hidden
  - **When** fleet and activity state changes
  - **Then** the provider does not run a background UI polling loop, and the next reveal publishes a fresh snapshot
- [ ] **Scenario: Keep the visible panel current**
  - **Given** the Runtime Ops view is visible
  - **When** agent lifecycle, attention, Bridge generation, workspace membership, or normalized activity changes
  - **Then** a coalesced refresh updates the affected rows and a manual refresh remains available
- [ ] **Scenario: Reset stale Bridge state on a new agent incarnation**
  - **Given** an agent name was cancelled during rebind and later starts, restarts, or resumes as a new process
  - **When** Runtime Ops reads Bridge health for the new incarnation
  - **Then** the old `cancelled` state cannot survive as the new process state; an unreset or unmapped cancellation is
    shown as unknown with a reason, never healthy or failed
- [ ] **Scenario: Work in narrow and wide placements**
  - **Given** the user resizes the panel or drags the view to a sidebar
  - **When** available width crosses the compact breakpoint
  - **Then** the dense table reflows into scan-friendly runtime rows without clipped controls, overlapping text, or
    horizontal page scrolling
- [ ] Runtime Ops is a statically contributed `WebviewView` inside a custom `viewsContainers.panel` container,
  not an editor `WebviewPanel`, TreeView, OutputChannel, or Terminal
- [ ] The v1 projection is read-only except for refresh and existing non-destructive navigation; it does not expose
  agent lifecycle, authentication, or vendor-account mutation actions
- [ ] Multi-root snapshots preserve workspace provenance for every agent, do not merge same-named agents, and visibly
  disambiguate duplicate workspace basenames with the shortest unique parent-path suffix
- [ ] Pure projection tests cover cumulative versus delta usage, unavailable reasons, throttles, Bridge generations,
  cancellation/new-incarnation reset, resumability, multi-root collisions, and deterministic ordering
- [ ] Provider tests prove no provider-owned interval is registered and hidden views receive no refresh callback until
  reveal, using fake timers and injected refresh/detection sources
- [ ] Browser and real VS Code visual proof cover empty, mixed, throttled, stale Bridge, wide panel, and narrow view states

## Non-goals

- Query vendor billing or quota APIs, scrape account dashboards, or claim parity with ccusage
- Add real-time network polling or run blocking vendor probes whenever the panel opens
- Derive context-window pressure from cumulative token usage without a normalized context limit
- Treat PATH presence as proof that a CLI is authenticated or healthy
- Replace Mission Control, Activity, the Tachyon sidebar, or the raw agent terminal
- Add destructive agent, Bridge, credential, or runtime-management actions in v1
- Provide historical charts, cost accounting, budgets, alerts, or cross-machine aggregation
- Create implementation backlog cards before this design is accepted

## Open questions

- **Ratification: visible naming.** Proposed panel title is `Runtime Ops`; proposed status-bar label is
  `$(pulse) Runtime`. Owner: maintainer.
- **Ratification: compatibility command.** Proposed behavior keeps the existing
  `tachyon.showRuntimeUsage` command id but changes its target from QuickPick to the panel. The QuickPick is removed
  after the panel reaches feature parity. Owner: maintainer.
- **Ratification: v1 interaction boundary.** Proposed v1 is read-only plus refresh; opening an agent terminal from a
  row is deferred until the information surface is dogfooded. Owner: maintainer.
- **Ratification: information architecture.** Proposed v1 uses one dense runtime table with expandable agent detail,
  not separate Runtime and Agents views. At narrow widths each row reflows into a labeled detail grid. Owner:
  maintainer.
