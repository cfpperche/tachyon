# 188 — tachyon-attention-detection

_Created 2026-06-09._

**Status:** shipped

**Closure:** 2026-06-09 — shipped at 6dbd6c9; 72/72 vitest + live VSCode-host integration (real sh agent: [y/n] -> needs-input -> answered -> reset); spec-verify pass logged in notes.md; residual: none.

**UI impact:** interaction

## Intent

Umbrella 187 item **F1**, decided "implement, full design" (user, 2026-06-09). With several agents in a grid, the real cost is noticing *which one stopped and is waiting for the human* (tool confirmation, trust prompt, y/n question) — an unnoticed waiting agent is idle time. Tachyon gains an **AttentionMonitor**: a poller in the extension host (every ~3s, `capture-pane` tail of each attention-enabled running agent) feeding a per-agent state machine with two combined signals. **Strong signal** — the pane tail matches a prompt pattern (built-in library + per-agent extras) while the pane is stable → state `needs-input` → filled yellow/bell icon in the sidebar, a counter badge on the ⚡ Activity Bar icon, and a toast (once per episode) with an "Open" action. **Weak signal** — pane stable ≥ `silenceSec` (default 8) AND the pane process subtree's CPU unchanged between polls (busy CPU = "thinking", suppresses) → state `idle` → dim outline-yellow icon + "idle Xs" description, no toast. Config: `attention: true|false|{silenceSec, patterns}` per agent; **default on for agents without `watch:` globs** (watch ⇒ watched service/build, silence is its normal state), off otherwise. The state is also exposed through the Bridge's `list_agents`, so coordinating agents can see a stuck sibling.

## Acceptance criteria

- [x] **Scenario: strong signal — prompt detected**
  - **Given** a running attention-enabled agent whose pane tail ends in a recognizable prompt (e.g. `Continue? [y/n]`) and stays unchanged
  - **When** the monitor polls
  - **Then** the agent enters `needs-input`: sidebar shows the alert icon + matched line, the Activity Bar badge counts it, and a toast with an "Open" action fires exactly once for the episode

- [x] **Scenario: episode resets on activity**
  - **Given** an agent in `needs-input`
  - **When** the pane content changes (human answered / agent resumed)
  - **Then** the state returns to `working`, the badge count drops, and a later identical prompt fires a new toast (new episode)

- [x] **Scenario: weak signal — idle vs thinking**
  - **Given** an attention-enabled agent whose pane is unchanged for ≥ `silenceSec`
  - **When** the process subtree's CPU ticks are unchanged between polls
  - **Then** state becomes `idle` (dim icon + duration, no toast); if CPU is advancing, the agent stays `working` (thinking suppresses the idle signal)

- [x] **Scenario: watch-agents are off by default**
  - **Given** an agent declared with `watch:` globs (dev server/build) and no explicit `attention:`
  - **When** it stays silent indefinitely
  - **Then** no attention state is reported for it (no badge, no toast); `attention: true` opts it back in

- [x] **Scenario: Bridge exposure**
  - **Given** an agent in `needs-input`
  - **When** any MCP client calls `list_agents`
  - **Then** the entry carries the attention state

- [x] `attention` field validates in config + JSON Schema (`true|false|{silenceSec>=1, patterns[]}`); invalid shapes produce path-qualified errors
- [x] Pattern classifier has unit coverage including a real Claude Code trust-prompt sample (from the spec 186 spike); state machine has unit coverage for all transitions (fake clock/IO)
- [x] Live integration: in the VSCode host, a real `sh` agent printing `[y/n]` reaches `needs-input` (asserted via an internal command), with real tmux + real poller
- [x] CPU read degrades gracefully where `/proc` is absent (macOS): stability alone drives `idle`; documented

## Non-goals

- Auto-answering prompts (the human decides; agents can already `write_input` deliberately).
- tmux `monitor-silence`/hooks as the mechanism — rejected in discussion (more moving parts than extension-host polling for the same result).
- OS-level (out-of-VSCode) notifications — VSCode toasts only in v1.
- Per-runtime prompt-state integrations (e.g. parsing Claude Code internals) — text-pattern + stability only.

## Open questions

_None — design closed in the umbrella discussion (2026-06-09)._

## Context / references

- Parent: `docs/specs/187-tachyon-v2-umbrella/` F1; product: `packages/tachyon/` (spec 186).
- Prior art: HiveTerm "notifies when they need you"; trsdn/HiveTerm "InputDetector — pattern matching plus process state analysis".
- Spike evidence (spec 186 notes.md): Claude Code trust prompt captured verbatim via `capture-pane` — basis for the pattern-library fixture.
