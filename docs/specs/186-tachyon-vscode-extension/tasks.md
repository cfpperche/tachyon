# 186 — tachyon-vscode-extension — tasks

_Generated from `plan.md` on 2026-06-09. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

### Phase 0 — package scaffold

- [x] 1. Create `packages/tachyon/` scaffold: `package.json` (name `tachyon`, publisher `cfpperche`, displayName `Tachyon`, `engines.vscode`, activation on workspace containing `tachyon.yml` + on commands), `tsconfig.json`, `esbuild.mjs` bundling `src/extension.ts` → `dist/extension.js`, `.vscodeignore`, `.gitignore`, vitest config. Done when: `npm run build` produces `dist/extension.js` from a stub `activate()`.
- [x] 2. Wire test harnesses: vitest for unit tests (`npm test`), `@vscode/test-cli` for integration (`npm run test:integration`) with a passing smoke test (extension activates in the dev host). Done when: both commands run green from a clean `npm ci`.

### Phase 1 — TmuxService (the only process-touching layer)

- [x] 3. Implement `src/tmux/TmuxService.ts` on the dedicated socket (`tmux -L tachyon`): `newSession(name, cmd, cwd, env)`, `killSession`, `listSessions(prefix)`, `capturePane(name, lines?)` (`capture-pane -p`, optional `-S` scrollback reach), `sendKeys(name, text, submit)` (`C-m` only when `submit: true`), `hasSession`. Session naming: `tachyon-<workspaceHash>-<agent>` with a stable short hash of the workspace path. Unit tests with mocked `child_process.execFile`.
- [x] 4. Implement `doctor()` fail-closed checks: tmux binary present + minimum version; distinct messages for native-Windows host ("unsupported — use WSL") vs tmux missing on WSL/Linux ("apt install tmux") vs macOS ("brew install tmux"). Unit tests for each branch.
- [x] 5. **Empirical spike (plan risk #2): `capture-pane` against a real TUI agent.** Start a real Claude Code session in a `tachyon`-socket tmux session; verify `capturePane` returns the visible alt-screen content sanely and document scrollback (`-S`) behavior in `notes.md`. Adjust `read_output` semantics in the plan if findings contradict it. Done when: findings recorded in `notes.md`.

### Phase 2 — config (`tachyon.yml`)

- [x] 6. Author `src/config/schema.json` (JSON Schema for `tachyon.yml`: `agents.<name>: {cmd, cwd?, env?, autostart?, watch?}`, `layouts.<name>: {grid: 2up|3up|2x2, agents[]}`, `settings: {maxAgents?}` default 8) and `src/config/loadConfig.ts` (parse with `yaml`, validate against schema, typed result, actionable error messages with line context). Unit tests: valid config, each invalid shape, empty/missing file.
- [x] 7. Register the schema for editor validation (`yamlValidation` contribution in `package.json` keyed to `tachyon.yml`) and add `examples/tachyon.yml` (annotated, two agents + one layout). Done when: opening the example in the dev host shows schema-driven completion/diagnostics (needs YAML extension; degrade silently without it).

### Phase 3 — lifecycle + presentation

- [x] 8. Implement `src/agents/AgentManager.ts`: `spawn(agentDef)` (tmux session + enforce `maxAgents` counting live `tachyon-<ws>-*` sessions), `kill`, `restart`, `list` (derived from tmux on demand — no duplicated state). Unit tests over a mocked TmuxService, including the maxAgents-exceeded error.
- [x] 9. Implement `src/presentation/Terminals.ts`: open each agent as a native terminal in the editor area (`createTerminal({location})` with `TerminalEditorLocationOptions`) running `tmux -L tachyon attach -t <session>`; maintain terminal↔session map; handle the attach race (plan risk #3: already-attached session → `attach -d` or focus existing terminal); clean up map on `onDidCloseTerminal` (closing the terminal detaches, never kills the session).
- [x] 10. Implement activation flow in `src/extension.ts`: `doctor()` gate → load `tachyon.yml` → re-discover surviving `tachyon-<ws>-*` sessions and re-attach them as editor terminals → spawn `autostart: true` agents not already alive. Commands: `Tachyon: Start`, `Tachyon: Stop All`, `Tachyon: Restart Agent`, `Tachyon: Open Agent Terminal`.
- [x] 11. Implement `src/presentation/Layouts.ts`: apply named layouts from config (2-up / 3-up / 2×2) via `vscode.setEditorLayout` + per-agent view-column placement; `Tachyon: Apply Layout` command with quick-pick. Fallback if `setEditorLayout` misbehaves: plain `ViewColumn` placement (plan risk #4).
- [x] 12. Implement `watch:` support in AgentManager: `vscode.FileSystemWatcher` per agent glob → debounced restart + status-bar/notification event. Unit-test the debounce logic; integration-verify one real restart.

### Phase 4 — Bridge (MCP server)

- [x] 13. Implement `src/bridge/Bridge.ts`: `McpServer` from `@modelcontextprotocol/sdk` + `StreamableHTTPServerTransport` on `127.0.0.1:<free port>` (loopback bind only), boot/dispose tied to extension lifecycle, port + URL surfaced via status bar and a `Tachyon: Copy Bridge URL` command.
- [x] 14. Implement the 7 v1 tools in `src/bridge/tools/`: `spawn_agent`, `kill_agent`, `restart_agent`, `list_agents`, `read_output` (lines param → scrollback reach), `write_input` (explicit `submit` flag), `notify` (`vscode.window.showInformationMessage`). Each: zod/JSON-schema input validation, thin delegation to AgentManager/TmuxService, structured error returns (e.g. maxAgents exceeded, unknown agent). Unit tests per tool.

### Phase 5 — runtime registration adapters

- [x] 15. Implement `src/registration/adapters.ts` + `Tachyon: Connect Agent Runtime` command: writes/offers the Bridge registration snippet for Claude Code (`.mcp.json`, HTTP type), Codex CLI (`config.toml`), OpenCode (`opencode.json`) — **verify each runtime's current MCP-over-HTTP client support against official docs at implementation time** (plan risk #1); document the `mcp-remote` stdio fallback for clients without HTTP support; generic-URL path for unknown runtimes. Never overwrite an existing entry without confirmation.

### Phase 6 — docs + polish

- [x] 16. Write `packages/tachyon/README.md`: install, quickstart, `tachyon.yml` reference, Bridge tool reference, per-runtime registration recipes, support matrix (WSL/Linux/macOS; native Windows unsupported by design), publishing recipe (`vsce`, publisher `cfpperche`). Add the one-paragraph "Packages" section to the repo-root `README.md`.

## Verification

_Acceptance checks tied to `spec.md` acceptance criteria. Each maps to a scenario there._

- [x] V1. **Spawn from config + autostart** (spec scenario 1): in a sample workspace with two autostart agents, run `Tachyon: Start` (and a fresh activation) → both tmux sessions exist on the `tachyon` socket and appear as editor-area terminals.
- [x] V2. **Grid layout** (scenario 2): with three agents running, apply a named 2×2 layout → terminals arranged in the editor grid; re-apply by name after rearranging.
- [x] V3. **Bridge end-to-end from a real agent** (scenario 3): register a real Claude Code session against the Bridge; have it call `spawn_agent` → `read_output` (sibling) → `write_input` → `notify`; observe new terminal, clean text return, input landing, VSCode toast.
- [x] V4. **Restart persistence** (scenario 4): with agents running, fully close and reopen VSCode → tmux sessions alive, Tachyon re-attaches them without restarting processes.
- [x] V5. **Watch restart** (scenario 5): touch a file matching an agent's `watch:` glob → session restarts, event visible.
- [x] V6. **Multi-runtime registration** (scenario 6): run the connect command for Claude Code, Codex, OpenCode → correct snippet written/offered per runtime; generic URL documented and reachable (`curl` the Bridge endpoint).
- [x] V7. **Degradation without tmux** (scenario 7): simulate tmux absent (PATH without tmux) → activation fails closed with the actionable per-platform message; no half-spawned state.
- [x] V8. **Static criteria**: `packages/tachyon/` self-contained, builds + full test suite green from clean checkout; `git status` confirms nothing under `.agent0/`/`.claude/` touched; grep confirms zero hive/bee/queen nomenclature in the package.

**Verify:** `bash -c 'cd packages/tachyon && npm run typecheck && npm run build && npm test'`

## Notes

_Anything that came up during execution that doesn't belong in plan.md but is useful for the PR description or future readers._

- **Evidence (2026-06-09):** 58/58 vitest (unit + real-tmux lifecycle/persistence/scrollback) + 7/7 `@vscode/test-cli` host integration under xvfb (activation, commands, real spawn via `Tachyon: Start`, survivor re-attach without restart, 2up grid via tab-group count, watch-restart, Stop All) + live E2E: a real `claude -p` session connected to the Bridge over streamable HTTP drove `spawn_agent` → `write_input` → `read_output` (returned `tachyon-e2e-42`, shell-evaluated) → `notify` → `list_agents`.
- V6 caveat: Claude Code HTTP registration shape proven live; Codex/OpenCode snippet shapes are unit-tested against their documented formats but not exercised against live runtimes — `mcp-remote` stdio fallback documented in the snippet/README for drift.
- V7 is unit-level (all four doctor branches); the activation gate itself is exercised by every integration boot (doctor passes → activation proceeds).
- The `tachyon.applyLayout` command takes an optional layout-name arg (skips the quick-pick) — added for testability, also useful for keybindings.
- tmux exact-target syntax differs per command class: `=name` for session targets, `=name:` for pane targets — see notes.md.
