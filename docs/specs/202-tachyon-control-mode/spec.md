# 202 — tachyon-control-mode

_Created 2026-06-10._

**Status:** shipped

**Closure:** 2026-06-10 — unit 175/175 (controlMode 11 + real-socket 3 new), xvfb integration 21 passing unchanged; dead-map latency measured 945ms on the real socket (~1.3s worst-case in-extension vs 3s+ before); residual: none

**UI impact:** none
<!-- Engine swap under tested monitors — behavior preserved; latency improves. -->

## Intent

F20: replace the spawn-a-subprocess-per-question conversation with tmux by a
persistent control-mode (`tmux -C`) client — eliminating subprocess churn and
turning lifecycle detection event-driven. The F19 seam (everything consumes
monitor transitions; nothing knows where they come from) means no Bridge tool,
schema, or UI changes. Constraints confirmed against the tmux wiki: a control
client sees only its attached session; there is NO pane-death notification —
death events come from a `refresh-client -B` subscription whose format loops
(`#{S:…}`) encode the server-wide dead-pane map, delivered as
`%subscription-changed` (≤1/s).

## Acceptance criteria

- [x] **Scenario: command channel replaces subprocess churn**
  - **Given** the extension is active with N running agents
  - **When** monitors/runners tick
  - **Then** tmux queries flow through ONE persistent control client (request/response over `%begin`/`%end`/`%error` blocks) — zero `tmux` subprocess spawns in steady state; behavior of all suites unchanged

- [x] **Scenario: event-driven lifecycle**
  - **Given** an agent crashes (dead pane) or is killed (session gone)
  - **When** the dead-map subscription changes / `%sessions-changed` fires
  - **Then** `lifecycle.tick()` runs immediately — crash toast/restart and waiter release within ~1s (today: up to 3s), measured live

- [x] **Scenario: degraded mode is safe**
  - **Given** the control client dies or cannot start (old tmux, races)
  - **When** any tmux call is made
  - **Then** execution transparently falls back to the existing per-call subprocess path, a reconnect with backoff runs behind it, and a single non-spammy warning is logged — never a hard failure

- [x] **Scenario: anchor session is invisible**
  - **Given** the control client needs an attached session
  - **When** Tachyon starts the engine (anchor `tachyon-ctl-<hash>`)
  - **Then** the anchor never appears in the sidebar, list_agents, commands, or Stop All counts, and is cleaned up on deactivate/Stop All

- [x] Real-tmux suite covers the client end-to-end (throwaway socket): connect, exec round-trip, octal-unescaped `%output`, subscription firing on pane death, reconnect after kill-server
- [x] Attention monitor SEMANTICS unchanged (capture+stability state machine stays); its captures ride the persistent channel
- [x] No version-notice churn: no tool schema change (patch bump only)

## Non-goals

- Streaming `%output` into the attention monitor (would require one client per
  session or window-linking tricks; the 2.5s stability gate dominates that
  latency anyway). Registered as an evidence-gated follow-up, not built now.
- Replacing CPU sampling (no tmux events for it — stays polled).
- Touching monitor state machines, Bridge tools, or the sidebar.

## Open questions

- [x] Subscription format-loop nesting (RESOLVED: spiked green on tmux 3.6 — see notes.md) (`#{S:…#{W:…#{P:…}}}`) across tmux versions ≥3.2 — task 1 spikes this on the real socket before anything builds on it.
