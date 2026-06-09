# 186 — tachyon-vscode-extension — plan

_Drafted from `spec.md` on 2026-06-09. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

Build Tachyon as the first member of a new `packages/` directory (`packages/tachyon/`), a self-contained TypeScript VSCode extension with its own `package.json`, esbuild bundling, and test suite. The architecture has four layers, built bottom-up so each is testable before the next depends on it:

1. **TmuxService** — the only layer that touches processes. Thin typed wrappers over `tmux` CLI calls (`new-session`, `capture-pane`, `send-keys`, `kill-session`, `list-sessions`), run on a **dedicated tmux server socket** (`tmux -L tachyon`) so user `.tmux.conf` and personal sessions are never touched. Sessions are namespaced `tachyon-<workspaceHash>-<agent>`. A `doctor()` check fails closed with an actionable message when tmux is absent (spec: graceful degradation).
2. **Config** — `tachyon.yml` loader + published JSON Schema. v1 schema: `agents.<name>: {cmd, cwd?, env?, autostart?, watch?}`, `layouts.<name>: {grid, agents[]}`, `settings: {maxAgents?}` (default 8 — fork-bomb guardrail, per resolved OQ). Parsed with `yaml`, validated with the schema; schema also registered for editor validation via `yamlValidation`/`jsonValidation` contribution.
3. **Presentation** — agents display as **native VSCode terminals in the editor area** (`createTerminal({location: {viewColumn}})` per `TerminalEditorLocationOptions`), each running `tmux -L tachyon attach -t <session>`. On activation, Tachyon lists `tachyon-<workspaceHash>-*` sessions and re-attaches survivors (spec: restart persistence). Named grid layouts (2-up/3-up/2×2) are applied via `vscode.setEditorLayout` + opening each agent terminal into its view column.
4. **Bridge** — MCP server embedded in the extension host: `@modelcontextprotocol/sdk` `McpServer` + `StreamableHTTPServerTransport` on `127.0.0.1:<free port>` (bind loopback only). v1 tool surface (resolves OQ): `spawn_agent`, `kill_agent`, `restart_agent`, `list_agents`, `read_output`, `write_input`, `notify`. `spawn_agent` enforces `maxAgents`. `read_output` = `capture-pane -p` (visible pane — correct semantics for TUI agents) with optional `lines` param reaching into scrollback (`-S`). `write_input` = `send-keys` with explicit `submit: true` → `C-m`. `notify` = `vscode.window.showInformationMessage`. The Bridge is near-stateless: agent registry derives from tmux on demand.

Order of implementation: scaffold → TmuxService → config → lifecycle commands + presentation → Bridge → registration adapters → watch/restart → docs + acceptance verification. Registration adapters are commands that write/offer the right MCP client snippet per runtime — `.mcp.json` (Claude Code, HTTP type), `~/.codex/config.toml` (Codex), `opencode.json` (OpenCode) — plus a generic "Bridge URL" doc for any other MCP client; stdio-only clients get a documented `mcp-remote` fallback.

## Files to touch

**Create (all under `packages/tachyon/` unless noted):**
- `package.json` — extension manifest: `name: tachyon`, `publisher: cfpperche`, activation events, commands, configuration (`tachyon.maxAgents`), `yamlValidation` contribution
- `tsconfig.json`, `esbuild.mjs`, `.vscodeignore`, `.gitignore` — build plumbing (esbuild bundle to `dist/extension.js`)
- `src/extension.ts` — activation: doctor check, config load, autostart, session re-discovery, Bridge boot
- `src/tmux/TmuxService.ts` — tmux wrapper layer (dedicated `-L tachyon` socket, namespacing, doctor)
- `src/config/schema.json` + `src/config/loadConfig.ts` — `tachyon.yml` JSON Schema + loader/validator
- `src/agents/AgentManager.ts` — lifecycle orchestration: spawn/kill/restart, autostart, `watch:` file watchers (`vscode.FileSystemWatcher` → restart), maxAgents enforcement
- `src/presentation/Terminals.ts` — editor-area terminal creation/attach/re-attach, terminal↔session mapping
- `src/presentation/Layouts.ts` — named layouts via `vscode.setEditorLayout`, save/apply commands
- `src/bridge/Bridge.ts` — MCP server (McpServer + StreamableHTTPServerTransport, free-port pick, lifecycle tied to extension)
- `src/bridge/tools/*.ts` — the 7 v1 tools, each a thin schema-validated handler over TmuxService/AgentManager
- `src/registration/adapters.ts` — Claude Code / Codex / OpenCode snippet writers + generic URL command
- `test/unit/**` — vitest unit tests (TmuxService mocked exec; config validation; tool handlers)
- `test/integration/**` — `@vscode/test-cli` smoke (activation, doctor fail-closed) + tmux-required integration tests (skipped when tmux absent)
- `README.md` — product README (install, tachyon.yml reference, Bridge tools, runtime registration recipes, WSL/Linux/macOS support matrix)
- `examples/tachyon.yml` — annotated example config

**Modify:**
- `README.md` (repo root) — one short "Packages" section introducing `packages/` and listing `packages/tachyon/`

**Delete:** none.

## Alternatives considered

### node-pty + xterm.js in a webview grid
The extension owns PTYs directly and renders terminals in a custom webview. Rejected: rebuilds terminal emulation VSCode already has, drags in a native module (`node-pty` rebuild pain per platform/electron version), loses native terminal UX (themes, fonts, accessibility), and loses free process persistence across editor restarts that tmux gives.

### Native VSCode terminals without tmux
Plain `createTerminal` + `sendText`. Rejected: the VSCode API cannot read integrated-terminal output, which kills `read_output` — the signature cross-agent coordination capability this whole project exists for.

### Standalone Bridge daemon (separate binary outside VSCode)
Would let agents coordinate with the editor closed. Rejected for v1: second artifact to distribute, loses direct access to `vscode.window`/layout APIs for `notify` and presentation; tmux already keeps agents alive when VSCode is closed. The TmuxService layer stays extension-independent so this can be extracted later (spec non-goal, "future scope").

### Per-agent stdio MCP server instead of shared HTTP
Each agent spawns its own Bridge instance over stdio. Rejected: stdio instances run outside the extension host, so `notify`/layout tools can't reach VSCode; and N agent runtimes would each spawn a process for what one HTTP endpoint serves statelessly.

## Risks and unknowns

- **Codex CLI HTTP-MCP client maturity** — Codex's MCP client support for streamable HTTP has been moving; if a runtime only speaks stdio MCP, the documented `mcp-remote` proxy fallback covers it. Verify per-runtime at implementation time (per `feedback_verify_runtime_capabilities` — check official docs, not training data).
- **`capture-pane` semantics for TUI agents** — full-screen TUIs (Claude Code) render an alternate screen; visible-pane capture is the right default but scrollback reach (`-S`) behaves differently in alt-screen mode. Needs empirical testing with a real Claude Code session early (Phase 1 test).
- **Attach race on re-discovery** — a tmux session can only have sane geometry with one attached client; opening a second attach terminal for an already-attached session needs `attach -d` or detection. Handle in Terminals.ts.
- **`vscode.setEditorLayout` is command-API, not stable typed API** — shape is `{orientation, groups}` via `executeCommand`; it works but is weakly documented. If it regresses, fall back to `ViewColumn.One/Two/...` placement without exact ratios.
- **Workspace trust / multi-root workspaces** — v1 assumes single-root workspace; multi-root resolves config from the first folder and is documented as such.
- **WSL specifics** — on Windows+WSL, VSCode Remote runs the extension host inside WSL, so tmux/exec all work; but the doctor message must distinguish "native Windows host" (unsupported, point to WSL) from "WSL with tmux missing" (apt install hint).
- **Spec OQ correction** — the `packages/mcp-product-pipeline/` precedent cited in spec § Context lives in a different repo; `packages/` does not exist in Agent0 yet. Tachyon creates it. (Resolves the "monorepo layout" OQ: `packages/tachyon/`, self-contained, never touched by sync-harness.)

## Research / citations

- Feature inventory: [hiveterm.com](https://hiveterm.com/) (this session, 2026-06-09); tmux-as-source-of-truth pattern: [opus-domini/sentinel](https://github.com/opus-domini/sentinel)
- VSCode API: [`TerminalEditorLocationOptions` / `TerminalLocation.Editor`](https://code.visualstudio.com/api/references/vscode-api) — native terminals as editor tabs; known limitation: no API to read integrated-terminal output (motivates tmux)
- MCP server: [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) — `McpServer` + [`StreamableHTTPServerTransport`](https://ts.sdk.modelcontextprotocol.io/documents/server.html); [Node MCP server implementation guide](https://github.com/anthropics/skills/blob/main/skills/mcp-builder/reference/node_mcp_server.md)
- stdio→HTTP fallback for stdio-only MCP clients: `mcp-remote` (npm)
- tmux mechanics: `man tmux` — `-L` socket isolation, `new-session -d`, `capture-pane -p -S`, `send-keys`, `list-sessions -F`
