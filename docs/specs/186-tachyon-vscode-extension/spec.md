# 186 — tachyon-vscode-extension

_Created 2026-06-09._

**Status:** shipped

**Closure:** 2026-06-09 — shipped at a388732; 58/58 vitest (unit + real-tmux) + 7/7 VSCode-host integration (xvfb) + live `claude -p` E2E driving all coordination tools through the Bridge (`tachyon-e2e-42` round-trip); spec-verify pass logged in notes.md. Residual: marketplace publishing is a human step (publisher `cfpperche` creation + `vsce publish`, recipe in package README); Codex/OpenCode registration shapes are unit-tested but not yet exercised against live runtimes (mcp-remote fallback documented).

**UI impact:** interaction

## Intent

Build **Tachyon** ("signals from the future") — a VSCode extension that turns the editor into a multi-agent orchestration workspace, functionally inspired by HiveTerm (hiveterm.com) but architected for VSCode instead of a standalone Tauri runtime. Developers running multiple AI coding agents (Claude Code, Codex, OpenCode, Gemini CLI, or any CLI process) today alt-tab between terminals with no cross-agent visibility or coordination. Tachyon gives them: (1) agents as **tmux sessions** displayed in native VSCode terminals placed in the **editor area** (grid layouts via editor groups); (2) a versionable **`tachyon.yml`** config defining agents, autostart, env, cwd, and restart-on-file-change; (3) the **Bridge** — an MCP server embedded in the extension host (HTTP on a free localhost port) exposing tools (`spawn_agent`, `kill_agent`, `restart_agent`, `read_output`, `write_input`, `notify`, …) so agents spawn sub-agents, read each other's output, and coordinate. tmux is the source of truth for process state: the Bridge is a near-stateless shim over `tmux` commands (`new-session`, `capture-pane`, `send-keys`, `kill-session`), which makes agent sessions survive VSCode restarts — a capability HiveTerm itself lacks. The extension lives as a self-contained monorepo package at `packages/tachyon/` (the `mcp-product-pipeline` precedent); it never touches Agent0's `.agent0/`/`.claude/` harness.

## Acceptance criteria

- [x] **Scenario: spawn agents from config**
  - **Given** a workspace with a `tachyon.yml` declaring two agents (e.g. `claude` and a dev server) with `autostart: true`
  - **When** the user opens the workspace (or runs the `Tachyon: Start` command)
  - **Then** each agent runs in its own tmux session (namespaced, e.g. `tachyon-<workspace>-<agent>`) and appears as a native VSCode terminal tab in the editor area

- [x] **Scenario: grid layout in the editor area**
  - **Given** three running agents
  - **When** the user applies a named layout (2-up / 3-up / 2×2) via command
  - **Then** the agent terminals are arranged in the corresponding editor-group grid, and the layout can be saved and re-applied by name

- [x] **Scenario: Bridge tools work end-to-end from a real agent**
  - **Given** a Claude Code session registered against the Bridge (via the generated MCP registration)
  - **When** the agent calls `spawn_agent`, then `read_output` on a sibling agent, then `write_input`, then `notify`
  - **Then** a new tmux session + terminal appears; the sibling's recent output is returned as clean text; the input reaches the sibling's stdin; a VSCode notification is shown to the human

- [x] **Scenario: sessions survive a VSCode restart**
  - **Given** running agents started by Tachyon
  - **When** VSCode is closed and reopened
  - **Then** the tmux sessions are still alive, and Tachyon re-discovers and re-attaches them as editor terminals without restarting the processes

- [x] **Scenario: restart-on-file-change**
  - **Given** an agent declared with a `watch:` glob in `tachyon.yml`
  - **When** a matching file changes
  - **Then** the agent's tmux session is restarted and the event is visible (notification or status)

- [x] **Scenario: multi-runtime registration**
  - **Given** the Bridge running on its auto-picked port
  - **When** the user runs the "connect agent" command for a known runtime (Claude Code, Codex CLI, OpenCode)
  - **Then** the correct config snippet (`.mcp.json` / `config.toml` / `opencode.json`) is written/offered, and any unknown MCP-capable runtime can connect using a documented generic URL

- [x] **Scenario: graceful degradation without tmux**
  - **Given** a machine without tmux installed (or native Windows outside WSL)
  - **When** the extension activates
  - **Then** it fails closed with a clear actionable message (install tmux / use WSL) instead of half-working

- [x] `packages/tachyon/` is self-contained (own `package.json`, build, tests, README); nothing under `.agent0/` or `.claude/` is modified by this spec
- [x] All product nomenclature is Tachyon-original (agents, Bridge, `tachyon.yml`) — no hive/bee/queen terms anywhere
- [x] Extension builds and its test suite passes from a clean checkout of `packages/tachyon/`

## Non-goals

- **Native Windows support** — tmux-based backend targets WSL/Linux/macOS only (user decision 2026-06-09); the tmux layer stays isolated so a future `PtyBackend` could add native Windows, but not in this spec.
- **Rebuilding what VSCode already provides** — no file explorer, fuzzy search, git diff/commit/PR UI, themes, or font management (HiveTerm features 4, 5, 9-adjacent); Tachyon leans on the host editor.
- **v2+ HiveTerm parity features** — pins/notes checklist, per-process CPU/mem monitoring with auto-restart, voice input, stack auto-detection. Deferred, not rejected.
- **Webview/xterm.js terminal rendering** — rejected in favor of native terminals attached to tmux; no custom terminal emulation.
- **Standalone headless daemon** — the Bridge lives in the extension host and dies with VSCode; a VSCode-independent stdio binary is future scope.
- **Token/API-key proxying or any cloud component** — everything local, BYO agent CLIs.
- **Syncing/shipping Tachyon to Agent0 consumer projects** — it is a monorepo product package, not harness material; sync-harness never touches it.

## Open questions

- [x] **Marketplace/package identity** — RESOLVED 2026-06-09: extension ID `cfpperche.tachyon` (`name: tachyon`, `displayName: Tachyon`, publisher `cfpperche` — personal publisher, transferable to a brand later). Marketplace "Tachyons" CSS extensions don't collide (IDs are publisher-scoped). Publisher creation is a human step at publish time (marketplace.visualstudio.com/manage + Azure DevOps PAT + `vsce login`); doesn't block development.
- [x] **Bridge tool surface for v1** — RESOLVED in `plan.md` (2026-06-09): the 7 core tools (`spawn_agent`, `kill_agent`, `restart_agent`, `list_agents`, `read_output`, `write_input`, `notify`); `set_status`/agent-metadata deferred to v2.
- [x] **`tachyon.yml` schema v1** — RESOLVED in `plan.md` (2026-06-09): `agents.<name>: {cmd, cwd?, env?, autostart?, watch?}`, `layouts.<name>: {grid, agents[]}`, `settings: {maxAgents?}`; JSON Schema published and registered for editor validation.
- [x] **Sub-agent depth/limits** — RESOLVED 2026-06-09: configurable cap (e.g. `maxAgents` in `tachyon.yml` and/or extension setting) with a sane default — a fork-bomb guardrail, not a monetization tier. Exact default value decided at plan time.
- [x] **Monorepo layout formalization** — RESOLVED in `plan.md` (2026-06-09): `packages/` does NOT yet exist in this repo (the mcp-product-pipeline precedent lives in a different repo); Tachyon creates it as `packages/tachyon/`, self-contained, never touched by sync-harness.

## Context / references

- Reverse-engineering source: [hiveterm.com](https://hiveterm.com/) (commercial, closed-source, Tauri+Rust+React, by Ebrahim P. Leite) — feature inventory captured in this session (2026-06-09): split-pane grid, `hive.yml`, Queen MCP server (~8–16 tools), git integration, pins, voice, stack detection, free/Pro $99-yr tiers. **Note:** GitHub `trsdn/HiveTerm` is an unrelated Swift/macOS homonym — not the product's source.
- Architecture inspiration for the tmux pattern: [opus-domini/sentinel](https://github.com/opus-domini/sentinel) (Go + web UI; tmux as process source of truth, UI attaches to panes).
- VSCode APIs: [`TerminalLocation.Editor` / `TerminalEditorLocationOptions`](https://code.visualstudio.com/api/references/vscode-api) — native terminals as editor tabs (enables grid via editor groups). Known API limitation motivating tmux: extensions cannot read integrated-terminal output.
- Key decisions (this session, 2026-06-09): tmux backend over node-pty/xterm.js-webview; native-terminal display + out-of-band tmux read/write; Bridge embedded in extension host (HTTP MCP, auto port); name **Tachyon** (collision-checked; Precog/Lightcone/Kairos all taken by active AI products); WSL/Linux/macOS only; original nomenclature (no hive/bee/queen).
- Repo precedent for self-contained packages: `packages/mcp-product-pipeline/` (memory: `feedback_mcp_package_self_contained`).
- Governance: `.agent0/context/rules/agent0-governance-doctrine.md` — Tachyon is a monorepo product package, not an Agent0 harness capacity.
