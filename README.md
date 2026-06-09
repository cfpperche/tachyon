# ⚡ Tachyon

**Multi-agent terminal orchestration for VSCode — signals from the future.**

Tachyon turns VSCode into a workspace for running multiple AI coding agents (Claude Code, Codex,
OpenCode, Gemini CLI — any CLI) side by side, with real cross-agent coordination:

- **Agents run as tmux sessions**, displayed as native terminals **in the editor area** — arrange
  them in 2-up / 3-up / 2×2 grids, all visible at once.
- **`tachyon.yml`** declares your agents (command, cwd, env, autostart, watch-restart) — config as
  code, committed with the repo, identical for the whole team.
- **The Bridge** — an embedded MCP server — lets agents spawn sub-agents, **read each other's
  output**, type into each other's terminals, and notify you. Any MCP-capable runtime connects.
- **Sessions survive VSCode restarts.** tmux owns the processes; close the editor, reopen it, and
  Tachyon re-attaches your still-running agents.

Everything is local: no cloud component, no token proxying, bring your own agent CLIs.

## Requirements

| Platform | Supported |
|---|---|
| Linux | ✅ (tmux ≥ 3.2) |
| macOS | ✅ (`brew install tmux`) |
| Windows + WSL | ✅ (VSCode Remote - WSL; tmux inside the distro) |
| Windows native | ❌ by design — use WSL |

## Quickstart

1. Create a `tachyon.yml` in your workspace root (see [`examples/tachyon.yml`](examples/tachyon.yml)):

```yaml
agents:
  claude:
    cmd: claude
    autostart: true
  dev:
    cmd: npm run dev
    autostart: true
    watch: "package.json"

layouts:
  pair:
    grid: 2up
    agents: [claude, dev]
```

2. Open the workspace — Tachyon activates, spawns the `autostart` agents in tmux, and opens their
   terminals in the editor area. (Or run **Tachyon: Start** from the command palette.)
3. Arrange the grid: **Tachyon: Apply Layout** → `pair`.

## Connecting an agent runtime to the Bridge

The Bridge listens on a free loopback port (see the `$(zap) Tachyon :PORT` status-bar item).
Run **Tachyon: Connect Agent Runtime** and pick your runtime:

| Runtime | Mechanism |
|---|---|
| Claude Code | writes/merges `.mcp.json` (`{"type": "http", "url": ...}`) in the workspace |
| OpenCode | writes/merges `opencode.json` (`{"type": "remote", ...}`) |
| Codex CLI | copy-paste snippet for `~/.codex/config.toml` (Tachyon never writes outside the workspace) |
| Anything else | generic URL; stdio-only clients: `npx -y mcp-remote <url>` |

> Runtime MCP client support evolves quickly — if a registration shape fails, check the runtime's
> official MCP docs and fall back to the `mcp-remote` stdio proxy.

### Bridge tools

| Tool | What it does |
|---|---|
| `spawn_agent` | start a declared agent, or an ad-hoc sub-agent with `cmd` (capped by `maxAgents`) |
| `kill_agent` | stop an agent (kills its tmux session) |
| `restart_agent` | kill + respawn with the same definition |
| `list_agents` | declared + running agents for this workspace |
| `read_output` | another agent's terminal: visible pane by default, `lines` reaches scrollback¹ |
| `write_input` | type into another agent's terminal (`submit: true` presses Enter) |
| `notify` | show the human a VSCode notification |

¹ Full-screen TUI agents (e.g. Claude Code) render an alternate screen with no scrollback history —
`lines` silently behaves like the visible capture for them; it works normally for plain CLI/server agents.

## Sidebar

The ⚡ Tachyon icon in the Activity Bar opens two sections:

- **Agents** — Bridge status (click to copy the MCP URL) + every declared/running agent with
  inline ▶ start / ■ stop / ↻ restart actions; clicking a running agent opens its terminal.
- **Layouts** — the named grids from `tachyon.yml`; click to apply.

Both refresh on lifecycle events and `tachyon.yml` edits (or via the ↻ title button).

## Commands

`Tachyon: Start` · `Tachyon: Stop All` · `Tachyon: Restart Agent` · `Tachyon: Open Agent Terminal` ·
`Tachyon: Apply Layout` · `Tachyon: Copy Bridge URL` · `Tachyon: Connect Agent Runtime` ·
`Tachyon: Refresh Views`

## Settings

- `tachyon.maxAgents` (default 8) — concurrent-agent guardrail; `settings.maxAgents` in
  `tachyon.yml` takes precedence.

## How it works

```
VSCode editor area                      tmux server (socket "tachyon")
┌──────────────┬──────────────┐
│ ⚡ claude     │ ⚡ dev        │  attach   tachyon-<ws>-claude
│ (native      │ (native      │ ────────▶ tachyon-<ws>-dev
│  terminal)   │  terminal)   │           (processes live here — and
└──────────────┴──────────────┘            survive editor restarts)
        ▲                                        ▲
        │ display                                │ capture-pane / send-keys
        │                                        │
   Bridge (MCP over HTTP, 127.0.0.1:<port>) ─────┘
        ▲
        │ spawn_agent / read_output / write_input / notify …
   your agents (Claude Code, Codex, OpenCode, …)
```

Tachyon runs its own tmux server (`tmux -L tachyon`) — your personal tmux sessions and
`~/.tmux.conf` are never touched. Sessions are namespaced per workspace.

## Development

```bash
npm ci
npm run build          # esbuild bundle -> dist/
npm test               # vitest: unit + real-tmux integration (auto-skips without tmux)
npm run test:integration   # @vscode/test-cli host smoke (downloads VSCode once)
npm run typecheck
```

Publishing (one-time human setup): create the `cfpperche` publisher at
marketplace.visualstudio.com/manage, then `npx vsce login cfpperche && npx vsce publish`.

## License

MIT — part of the [Agent0](../../README.md) monorepo.
