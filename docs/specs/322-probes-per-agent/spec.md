# 322 — probes-per-agent

_Created 2026-07-01._

**Status:** shipped

**Closure:** Shipped 2026-07-01. Probes are now per-agent: a "Probes" action in every AI agent row's "…" menu (`src/sidebar/actions.ts`, available wherever Activity is — durable records, pane-independent, kept during graceful stop) opens a panel scoped to that agent (`buildProbeView(records, now, caller)` — the single shared filter for rows AND counts; `ProbeResultPanelManager` keyed per workspace+caller so panels sit side by side). Global surfaces removed: header `ProbesBtn` chip + `fleet.probes` producer/field + `GlobalOp openProbes` + the view-title toolbar button; `tachyon.openProbes` is palette-hidden and stays only as the row-action target (its agent-less form is an internal escape hatch for caller-less/orphaned records, documented in code). Design dueto run VIA the probe system itself (probe-01bdc488, runtime codex, adversarial-review): verdict NEEDS-REVISION, 6 findings folded (composite-panel contract, contribution audit, single filter point, accepted running-signal regression, package.json verification, surface ripgrep audit), 1 rebutted with rationale (data-dependent menu hiding). Validation: 3 new caller-filter tests + probes action-matrix test, full suite 141 files/1966 tests green except one PRE-EXISTING i18n failure from in-flight spec 318 (verified present on clean main via stash; pinned as p-27eed2 — not this spec's), tsc main+webview clean, verify+dogfood logged. Human dogfood: visual pass pending next VSIX install.

## Intent

_Origin: pin `p-d25af8` (human, with screenshot of the current global "Captured probes" panel)._

Probes are surfaced globally today: a transient header chip in the sidebar (`ProbesBtn`, only while probes are running) plus an always-visible view-title toolbar button open one workspace-wide "Captured probes" panel listing every probe ever captured, across all agents. The pin's ask: probes belong to the agent that fired them — each agent row's "…" (more) menu should offer a "Probes" action opening that agent's own probes, and the global surfaces should go away. The data layer already supports this: every probe records `caller` (the launching agent) in `.tachyon/probes/<runId>/metadata.json`, and the current panel even renders a CALLER column — only the navigation/filtering is missing.

"Done" means: an AI agent's "…" menu has a Probes action that opens a panel titled for that agent listing only `caller === <agent>` probes; the header chip, the view-title toolbar button, and the palette entry for the global list are gone; probes without a caller (or from a dismissed agent) remain reachable through a non-prominent escape hatch rather than becoming orphaned.

## Acceptance criteria

- [x] **Scenario: per-agent probes from the "…" menu**
  - **Given** an AI agent that has launched probes (records with `caller` = its name)
  - **When** the user picks the new Probes action in the agent row's more-menu
  - **Then** a panel opens titled for that agent, listing only that agent's probes (all statuses), newest first
- [x] **Scenario: an agent with no probes gets an honest empty state**
  - **Given** an AI agent that never launched a probe
  - **When** its Probes action is used
  - **Then** the panel opens with a clear "no probes launched by this agent" empty state (the action is not hidden — discoverability over surprise)
- [x] **Scenario: global surfaces are removed**
  - **Given** the sidebar with probes running
  - **When** the fleet header renders
  - **Then** no probes chip appears (component + `fleet.probes` producer removed), and the view-title toolbar button + command-palette entry for the global list are gone
- [x] **Scenario: unattributed probes stay reachable**
  - **Given** probe records whose `caller` is absent or names no current agent
  - **When** the user needs them (debug/audit)
  - **Then** an escape hatch (the internal command invoked without an agent) still opens the unfiltered list — not prominent, but not orphaned data
- [x] The Probes action is offered for AI agents (`ai: true`) in the MORE menu only (never inline primary), for any lifecycle state that keeps Activity available — probes are durable records like the activity log, not tied to a live pane.
- [x] Two agents' probe panels can be open side by side (panel keyed per workspace+agent), matching how Activity panels behave.
- [x] `ProbeStore`/`ProbeService`/Bridge tool contracts are unchanged — this is a view/navigation refactor; no metadata migration.

## Non-goals

- No per-agent RUNNING count badge on the agent row — **v1 explicitly accepts losing the ambient live running-probes signal** (probe-dueto F2; the pin itself asks for the chip's removal). The per-agent panel shows running counts once opened; a row badge is the named follow-up if the loss is felt in practice.
- No probe actions beyond viewing (no per-row rerun/kill from the panel).
- No change to how `caller` is captured or validated (stays the free-string agent name the Bridge receives).
- No terminals support (`ai: false` rows never launch probes).

## Open questions

- None — see plan.md for the folded design dueto (run VIA the probe system itself, per the maintainer's instruction: probe-01bdc488, verdict NEEDS-REVISION, 6 findings folded, 1 rebutted with rationale).
