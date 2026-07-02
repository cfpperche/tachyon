# 329 — bridge-dismiss-agent

_Created 2026-07-02._

**Status:** shipped
**Closure:** Shipped locally in this worktree. Evidence: `npm test -- --run test/unit/bridge.test.ts test/unit/agentManager.test.ts`, `npm run typecheck`, `npm run build`, and `/sdd dogfood --run` for the focused `dismiss_agent` path.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Bridge-spawned ad-hoc agents can finish cleanly before a human or parent agent reads their pane. Tachyon keeps
those clean-exit rows in the sidebar/listing for postmortem visibility, but the Bridge only exposes
`kill_agent`, which applies to live tmux sessions. A stopped ad-hoc row therefore cannot be removed by an
agent operating through the Bridge; the only current workaround is to respawn the same name and kill it.

Done means the Bridge exposes an explicit `dismiss_agent` operation for stopped ad-hoc rows. It must be
safe: never delete declared agents, never orphan a still-running ad-hoc session, and refresh the sidebar the
same way the existing UI dismiss path does.

## Acceptance criteria

- [x] **Scenario: stopped ad-hoc row is dismissed through the Bridge**
  - **Given** an ad-hoc agent that is no longer running and still appears in `list_agents`
  - **When** a Bridge client calls `dismiss_agent(name)`
  - **Then** the ad-hoc definition, lineage, ledger footprint, and activity footprint are removed, and the row no longer appears in `list_agents`
- [x] **Scenario: running ad-hoc row is not dismissed**
  - **Given** an ad-hoc agent with a live tmux session
  - **When** a Bridge client calls `dismiss_agent(name)`
  - **Then** the call fails with guidance to use `kill_agent` first, and the agent remains listed/running
- [x] **Scenario: declared agents are protected**
  - **Given** an agent declared in `tachyon.yml`
  - **When** a Bridge client calls `dismiss_agent(name)`
  - **Then** the call fails and does not remove config, ledger, or listing state
- [x] **Scenario: kill on stopped ad-hoc points to dismiss**
  - **Given** an ad-hoc agent that is stopped/clean-exited
  - **When** a Bridge client calls `kill_agent(name)`
  - **Then** the call fails without removing the row and suggests `dismiss_agent`
- [x] `dismiss_agent` is included in the Bridge tool list and its description clearly says it is for stopped ad-hoc entries only.
- [x] Bridge-initiated dismiss triggers the same agent-view refresh path as UI dismiss.

## Non-goals

- No broad lifecycle refactor.
- No change to `kill_agent`'s core meaning: it remains the tool for live sessions.
- No deletion of declared agents through the Bridge; YAML-backed deletion stays UI/config-editor owned.
- No persistent transcript/archive retention redesign.

## Open questions

- OQ1: Should duplicate dismiss be idempotent or an error? Decision for v1: error clearly as "agent not found"
  after the first successful dismiss, because the Bridge listing is the source of truth for callability.
