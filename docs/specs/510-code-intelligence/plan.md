# 510 — code-intelligence — plan

_Drafted from `spec.md` on 2026-08-17. The approach, not the steps (those go in `tasks.md`). This delivery writes the contract only; the file list below is what a later implementation will touch._

## Approach

Two layers, in this order, after this spec is accepted:

1. **Catalog.** Setting → Workspace predicate → four `registerTool` calls behind `if (enabled)`, in a new `packages/bridge/src/tools/code-intelligence.ts` registered from `packages/bridge/src/tools.ts`. Flip reuses `Bridge.forceToolListRefresh`. Execution talks to a host-owned pool port, not to a language server from the Bridge package.
2. **Pool.** A host service keyed by `fs.realpath` of the worktree root. Lazy spawn of configured servers, disk-only reads, idle dump, evict-under-`withLock` after occupancy, orphan reap on host start.

Do not start with the matrix row. The remedir already lives in `spec.md`. A typed dimension is a last slice, and only if the owner still wants one after the tools exist.

No product code ships in the same change as this document.

## Key decisions

- **Bridge tools, not plugin MCP and not a per-runtime `lsp.json` projection.** Plugin MCP still renders only Claude and Codex (`packages/engine/src/plugins/mcp.ts`). Grok’s adapter leaves `mcpRel` deferred on purpose (`packages/engine/src/plugins/adapters/grok.ts`). Projecting `.grok/lsp.json` was withdrawn (`t-52964c`) because it is ambient Grok input and a hard attestation blocker. Rejected: re-opening that file. Rejected: teaching the plugin engine a third MCP codec just to reach Grok.
- **Opt-in on the `tabTools` mold, not always-on.** Code intelligence starts language-server processes. Default off. Rejected: listing the tools for everyone and failing at call time only — that pollutes every runtime’s catalog with a capability the human did not ask for. `ide_browser_*` (always listed, fail at call) is the other mold; it is wrong here because the cost is a process pool, not a missing CDP bridge.
- **Listing and execution stay separate.** Rejected: hiding a tool when no server is live. A `.php` file in a TypeScript repo would make the tool flicker. Precedent is `companionBrowserPaired`: list when the setting is on; say what is missing when called.
- **Four tools by input shape, `code_*` names.** Rejected: one `lsp` tool with a 10-value enum (the schema would accept `query` on `hover`). Rejected: `lsp_*` names — the agent does not need the transport. Rejected: matching Claude’s or Grok’s native operation names one-for-one; Tachyon exposes the union that is useful, not a clone of either CLI.
- **Route by extension at call time.** Rejected: `detectStack`’s first-match winner as the router. That function is for Init terminals (`apps/vscode-extension/src/init/initLogic.ts`) and stops at the first manifest. Reuse the inventory; score all matches.
- **Do not package a language-server binary.** Rejected: shipping `typescript-language-server` / `rust-analyzer`. Version drift and size are the product’s problem only if we own the binary. Status tells the human what to install.
- **Pool keyed on resolved worktree root, not agent id.** Rejected: per-agent servers (N-way RAM for one disk). Rejected: keyed on cwd string without `realpath` (symlink / trailing-slash splits).
- **No document sync.** Rejected: per-agent `textDocument/didOpen` overlays. Two agents on one path would contaminate each other’s buffers. Disk is the shared truth.
- **Pool yields, never vetoes.** Rejected: a fifth `WorktreeOccupancy` reason. That type carries `agent`/`cwd` and the refusal names an agent (`WorktreeManager.remove`). A cache pretending to be an agent would lie in the UI. Evict inside `withLock` after occupancy, before git. Rejected: evicting on `dismiss_agent` / `kill_agent` — the worktree survives, restart should reuse the index.
- **Orphan scan on host start is in scope.** Rejected: “hygiene will catch it.” Hygiene does not run when no worktree is being removed. Reload/crash is that door (`t-e73e54` shape: same actor, other trigger).
- **No claim on dimension 19.** That row is `design_mode_chat_reply` (`docs/runtimes/parity.md`, SDD 508 fatia 6). If a typed dimension is added later, it is a new `PARITY_DIMENSIONS` key. `runtime: wired` is illegal; `unmeasured` requires `needed`. Rejected: editing `parity.md` prose without a cell. Rejected: adding the cell in this spec-only change.
- **This change is documents only.** Rejected: landing the setting, the tools, or an empty pool stub “to reserve the names.” The brief forbids product code.

## Files a later implementation will touch

None of these are edited in this delivery.

| Path | Role |
|---|---|
| `packages/engine/src/config/loadConfig.ts` | Parse `settings.codeIntelligence.tools` (boolean, unknown keys discarded like `companion`). |
| `apps/vscode-extension/tachyon.schema.json` | Schema for the setting. |
| `packages/engine/src/workspace/Workspace.ts` | Predicate + `forceToolListRefresh` on flip (copy the `tabTools` block at the config-reload path). |
| `packages/engine/src/workspace/WorkspaceBridgePort.ts` | Thread the predicate (and later the pool port) into Bridge deps. |
| `packages/bridge/src/tools/shared.ts` | `codeIntelligenceToolsEnabled` on `BridgeDeps`. |
| `packages/bridge/src/tools/code-intelligence.ts` | **New.** Four tools. List gate vs call gate. |
| `packages/bridge/src/tools.ts` | `registerCodeIntelligenceTools` in catalog order. |
| `packages/engine/src/engine-service/extensionOperationService.ts` | Optional Control toggle, mold of `config.companion.tabTools`. |
| `packages/engine/src/worktree/WorktreeManager.ts` | After occupancy passes inside `withLock`, call `pool.evict(realpath)`. Do not extend `WorktreeOccupancy`. |
| `packages/engine/src/worktree/hygieneAuthority.ts` | Unchanged authority. Cite only to keep the three layers distinct. |
| `packages/engine/src/worktree/classify.ts` | Unchanged material safety. |
| host start (extension `activate` / engine daemon boot) | Orphan scan. Exact file chosen at implementation; must be a start trigger, not a remove trigger. |
| `apps/vscode-extension/src/init/initLogic.ts` | Read-only reuse of the manifest inventory; do not change first-match-wins for Init. |
| `packages/engine/src/runtime/parity.ts` | **Only if** the owner still wants a typed dimension after the tools exist. New key, never row 19. |
| `docs/runtimes/parity.md` | Narrative pointer to the cell, if and when the cell exists. |
| `test/unit/` | One test file per actor×trigger row in the spec. Fail-before on a second door. |

## Risks & unknowns

- **Staleness (open question 1).** A shared pool without `didChangeWatchedFiles` will answer from a stale index after an edit. Measure opportunistic `stat` on the consulted file before writing a watcher. The transitive case (`edit A`, `findReferences` on `B`) is the one that can make the tool worthless.
- **RAM (open question 3).** rust-analyzer × N worktrees is the known killer. Do not implement the pool without a written cap. A computed “free RAM at process start” policy is rejected by project guidance (`t-6a9bc4` and siblings); pick a fixed number.
- **Queue (open question 2).** Without a timeout, the Nth agent waits on `workspaceSymbol` and the tool looks hung. Fail with “server busy” rather than blocking the Bridge request forever.
- **Orphan scan false positives.** Killing “any process whose cwd was a Tachyon worktree” is a name-pattern kill and is forbidden. Track PIDs the pool spawned; reap only those. On crash the ledger is gone — then match the pool’s own child command lines recorded before spawn, not `pkill -f rust-analyzer`.
- **Grok 1.0.4 `code_nav`.** Web-only today. If a later Grok TUI exposes it without `lsp.json`, remedir before changing this contract. Do not treat `codebase_indexing = true` as a TUI door; it is not.
- **Claude already has nine native operations.** The Bridge tools are still justified: Codex has zero, Grok TUI still needs a file Tachyon will not write, and a single catalog is the parity the matrix can measure.

## Visual impact

A later Control toggle (if one is added) is a settings row, not a new screen. No visual QA in this delivery.

**Visual QA Opt-Out:** contract only; no rendered surface.

## Sources consulted

- `t-4fbbb2` body + journal `j-01d406a7c12d` (2026-08-17 rewrite) and `j-b411f585abbd` (this remedir).
- Installed CLIs: Claude 2.1.233, Grok 1.0.4, Codex 0.147.0 (2026-08-17). Isolated Grok `inspect` under scratch `HOME`/`GROK_HOME`. Codex `features list` + `app-server generate-json-schema --experimental`.
- `packages/engine/src/runtime/parity.ts` — typed cell, `runtime: wired` refused.
- `docs/runtimes/parity.md` — row 19 is `design_mode_chat_reply`.
- `packages/bridge/src/tools.ts`, `tools/user-browser.ts`, `tools/shared.ts`, `Bridge.ts` — `tabTools` / `companionBrowserPaired` / `forceToolListRefresh`.
- `packages/engine/src/workspace/Workspace.ts` — setting flip.
- `packages/engine/src/worktree/WorktreeManager.ts`, `hygieneAuthority.ts`, `classify.ts` — occupancy, lock, three layers.
- `packages/engine/src/plugins/mcp.ts`, `plugins/adapters/grok.ts` — MCP render scope; Grok `mcpRel` deferred.
- `packages/engine/src/config/grokNativeConfigProjection.ts` — `features.lsp_tools` withdrawn (`t-52964c`).
- `apps/vscode-extension/src/init/initLogic.ts` — `detectStack` first-match-wins.
- SDD 508 (`docs/specs/508-paridade-verificavel/`) — how a new dimension must look.
- SDD 414 — Companion `tabTools` mold.
- Grok bundled guide (in-binary, 1.0.4) § LSP Servers; `~/.grok/docs/user-guide/05-configuration.md`.
