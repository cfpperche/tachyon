# 330 — postmortem-agent-ux

_Created 2026-07-02._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Tachyon intentionally keeps clean-exited ad-hoc rows visible after the tmux session is gone so a parent agent or
human can notice the outcome and decide whether to inspect, resume, restart, or dismiss. Spec 329 added
`dismiss_agent`, which fixes removal, but the surrounding UX/DX still speaks in inconsistent primitives:
`list_agents` exposes the stopped row, `read_output` says only "not running", `wait_for_agent(until=dead)` does
not offer a final tail, and sidebar actions still derive from old pane/session assumptions.

Done means the Bridge and sidebar expose postmortem rows as a first-class state with honest capabilities:
agents can tell whether output is readable, whether a row can be dismissed, and what to do next without racing a
dead tmux pane or guessing from lifecycle booleans. The output contract is bounded: Tachyon may retain a small
postmortem tail for a stopped row, but it must say when output is missing or truncated.

## Acceptance criteria

- [ ] **Scenario: stopped listed row has explicit read-output behavior**
  - **Given** an ad-hoc agent that clean-exited and still appears in `list_agents`
  - **When** a Bridge client calls `read_output(name)`
  - **Then** the response distinguishes "stopped but listed" from "unknown/not managed"; if bounded postmortem output exists it returns that output with postmortem/truncation metadata, otherwise it returns a state-specific error that says no postmortem output is available.
- [ ] **Scenario: wait can return the final tail**
  - **Given** a Bridge client is waiting for an agent to reach `dead`
  - **When** the client passes `tailLines`
  - **Then** `wait_for_agent` returns the normal wait result plus a bounded final `tail` when available, avoiding the `wait dead -> read_output` race.
- [ ] **Scenario: list_agents exposes lifecycle capabilities**
  - **Given** any managed row returned from `list_agents`
  - **When** the row is serialized for Bridge clients
  - **Then** it includes nested advisory capability metadata for output readability and dismissability, with enough reason metadata for a client to avoid invalid tool calls.
- [ ] **Scenario: sidebar actions match postmortem capability**
  - **Given** a clean-exited ad-hoc row in the Agents or Terminals section
  - **When** the sidebar renders its primary and overflow actions
  - **Then** it offers Activity/Resume/Restart when relevant, exposes Dismiss as the cleanup action, and does not present Kill/Stop/Open Terminal actions that cannot succeed.
- [ ] **Scenario: running and declared guardrails remain intact**
  - **Given** a running ad-hoc row or a declared row
  - **When** a Bridge client or sidebar user attempts a postmortem-only action
  - **Then** Tachyon rejects the action with specific guidance and leaves the row/session/config intact.
- [ ] Tool descriptions for `read_output`, `wait_for_agent`, `list_agents`, and `dismiss_agent` document the postmortem contract.
- [ ] Postmortem output retention is size-bounded, marks truncation, and is destroyed by `dismiss_agent`.
- [ ] Existing Bridge clients that ignore the new fields keep working.

## Non-goals

- No new persistent transcript/archive store in this spec. The postmortem output buffer is bounded and session-local;
  existing activity/transcript surfaces remain the durable history.
- No change to `write_input`: writing remains live-session-only.
- No broad redesign of agent lifecycle or row grouping.
- No auto-dismiss of clean-exited rows; postmortem visibility remains intentional.
- No Marketplace publish.

## Open questions

- OQ1: RESOLVED in implementation plan: retain at most 1000 lines / 64 KiB per session-local postmortem buffer;
  `wait_for_agent(tailLines)` clamps caller-requested tail to 200 lines plus the same byte cap.
- OQ2: Should the sidebar action be a new `dismiss` action id or reuse the existing `delete` action with a
  dynamic "Dismiss" label? Initial preference: introduce `dismiss` in the action matrix and route it to the
  same command handler, so UI and Bridge vocabulary match.
