# 386 — agent-live-resource-metrics

_Created 2026-07-14._

**Status:** in-progress

**Branch:** `grok/agent-live-resource-metrics`

## Intent

Show **live CPU and memory** for each running agent without polluting the badge row. Metrics live on **collapsible detail lanes (L3–L5)**; hierarchy collapse of subagents stays on the existing left chevron. A separate metrics control + collapsed peek surface the data.

## Acceptance criteria

- [ ] **Scenario: running agent can expand metrics**
  - **Given** a running agent with a resolvable pane pid
  - **When** the operator expands metrics for that agent
  - **Then** L3 shows CPU (bar + %) and L4 shows RSS (bar + M/G)
- [ ] **Scenario: default collapsed with peek**
  - **Given** a running agent with samples
  - **When** metrics are collapsed
  - **Then** L2 badges stay free of CPU/mem and L1 shows a compact peek `N% · XM`
- [ ] **Scenario: stopped omits metrics**
  - **Given** a stopped/exited agent
  - **When** the row renders
  - **Then** no peek, no metrics toggle, no detail lanes
- [ ] **Scenario: tree collapse independent of metrics**
  - **Given** a parent with children and metrics open
  - **When** the parent hierarchy chevron collapses children
  - **Then** children hide and metrics for the parent remain open if they were open
- [ ] **Scenario: expand/collapse all metrics**
  - **Given** multiple running agents
  - **When** Expand metrics / Collapse metrics is used
  - **Then** all running agents open or close metrics together
- [ ] **Scenario: toolbar gutter**
  - **Given** L1 with peek and hover actions
  - **When** the row is hovered
  - **Then** actions stay top-right and do not cover the agent name (reserved gutter)
- [ ] Linux-only sampling (macOS omits samples cleanly)
- [ ] Badge order on L2 unchanged (branch first from spec 384)

## Non-goals

- GPU, network, disk, long history charts
- Status bar, kill-on-high-resource, quotas
- Changing hierarchy collapse semantics

## Open questions

None — UX locked via `docs/prototypes/agent-live-cpu-memory.html` and maintainer approval.
