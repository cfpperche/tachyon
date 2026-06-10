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

The Bridge listens on a **stable per-workspace port** (derived from the workspace path,
range 41000–42999 — same workspace, same port, forever), so a registration is a **one-time
step that survives editor restarts**. Pin a specific port with `settings.bridgePort` in
`tachyon.yml`; if the preferred port is ever busy, Tachyon falls back to an ephemeral one
and warns you. The current port shows in the `$(zap) Tachyon :PORT` status-bar item.

Run **Tachyon: Connect Agent Runtime** and pick your runtime. Registration is **idempotent
and merge-safe**: pre-existing MCP config files are preserved (only the `tachyon` key is
written), and re-running the command when the file is already correct is a no-op.

### Authentication

The Bridge requires `Authorization: Bearer <token>` by default (disable with
`settings: {auth: false}`). The token is **stable per workspace** and lives in the
extension's storage — **never in a committable file**: registered configs reference the
`TACHYON_BRIDGE_TOKEN` env var (`${VAR}` in `.mcp.json`, `bearer_token_env_var` in Codex,
`{env:VAR}` in OpenCode), and Tachyon **injects that variable into every agent session it
spawns** — agents authenticate automatically, zero manual steps. External sessions (an
agent CLI you start yourself, outside Tachyon): `Tachyon: Copy Bridge Token` →
`export TACHYON_BRIDGE_TOKEN=...`.

Honest threat model: loopback binding blocks the network; the token raises the bar against
generic local port scanners and accidents (notably `write_input` reaching your shells).
Same-user targeted malware that reads extension storage is out of scope.

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

## Attention detection — "this agent needs you"

With several agents in a grid, the expensive part is noticing which one stopped to ask you
something. Tachyon watches each agent's pane (every ~3s) and signals:

- **`needs-input`** (strong, high-precision): the pane tail ends in a recognizable prompt
  (`[y/n]`, `Enter to confirm`, password prompts, numbered selectors, …) and is stable →
  yellow bell in the sidebar, a counter badge on the ⚡ Activity Bar icon, and a one-time
  toast with an **Open** button.
- **`idle`** (weak, informational): no output for `silenceSec` (default 8s) *and* the process
  subtree's CPU is flat (busy CPU = thinking, suppresses) → dim outline icon + "idle 2m".
  Never toasts.

Per-agent config (defaults: **on** for plain agents, **off** for `watch:`ed services — their
silence is normal):

```yaml
agents:
  claude:
    cmd: claude            # attention on by default
  dev:
    cmd: npm run dev
    watch: "package.json"  # attention off by default
  legacy-repl:
    cmd: ./repl
    attention:
      silenceSec: 30
      patterns: ["AGUARDANDO COMANDO"]   # extra regexes (case-insensitive)
```

The state is also visible to other agents via the Bridge's `list_agents` (`attention` field) —
an orchestrating agent can spot a stuck sibling and `write_input` the answer or `notify` you.

On macOS there is no `/proc`, so the CPU check degrades gracefully: pane stability alone
drives `idle`; `needs-input` is unaffected.

## Crash lifecycle — exit codes, postmortem, auto-restart

When an agent's process dies on its own, the session doesn't vanish: the **dead pane is
kept** (last output + stack trace visible in its terminal) and the sidebar shows
**`crashed — exit N`** in red, with ↻ restart / ■ dismiss actions. You get a notification
with the exit code; clean exits (code 0) are just informational. Intentional kills
(Stop All, ■, `kill_agent`) stay silent — Tachyon distinguishes them structurally.

Opt into auto-restart per agent:

```yaml
agents:
  dev:
    cmd: npm run dev
    restart: on-crash   # default: never
```

`on-crash` restarts only non-zero exits, with backoff (2s/4s/8s) and a crash-loop guard:
3 restarts within a minute → Tachyon gives up, keeps the postmortem, and tells you.
A manual restart clears the guard. Crash state (`crashed`, `exitCode`) is visible to
other agents via `list_agents`.

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
