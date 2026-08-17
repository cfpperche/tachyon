# 510 — code-intelligence

_Created 2026-08-17._

**Status:** draft
**Task:** `t-4fbbb2`
**Cookbook-Opt-Out:** this delivery is the contract; no operator surface ships here.
**Visual QA Opt-Out:** no rendered surface in this delivery.
**Dogfood-Opt-Out:** no product behavior ships; the remedir is static/inspect, not a product path.

## Intent

The three first-class runtimes do not give an agent the same code-intelligence door. Tachyon’s parity table has never measured that door. Providing it on the Bridge — one opt-in catalog that all three can call — is the only shape that covers Codex, which still has no native LSP, and Grok’s TUI, which still hides its `lsp` tool behind a flag plus a hand-written `lsp.json` that Tachyon refuses to project.

This spec is the contract for that Bridge surface. It does not implement it. The design on `t-4fbbb2` survived the monorepo and SDD 508; the framing did not. Native capacity was remeasured on 2026-08-17 before this document was written. Codex 0.147.0 still has no native code intelligence, so the central premise holds and the spec proceeds.

Done looks like: four `code_*` tools, listed only when a human setting is on, executable without a live language server (actionable error, not hidden), routed by file extension at call time, backed by a host pool keyed on the resolved worktree root that **yields** on cleanup and never becomes occupancy. A typed parity cell may be added later; it must not take row 19, and it must not use `runtime: wired`.

## Remedir (2026-08-17) — the stop condition

No model call. Evidence is installed CLI help, `features list`, isolated `inspect`, generated app-server schema, and product strings in the installed binaries. Invented method or flag names are the required negative control.

| Runtime | Version | Measured | Native code intelligence | Negative control |
|---|---|---|---|---|
| Claude Code | 2.1.233 | 2026-08-17 | **Yes — 9 operations** on the built-in LSP tool: `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`. `--bare` still documents skipping LSP. | `tachyonInventedMethodXyz`, `goToUnicorn`, `hoverUnicorn`, `workspace/didNotExist` — **0 hits** in the binary. |
| Grok | 1.0.4 (`d846eb93d9`) | 2026-08-17 | **TUI `lsp` tool still exists, still gated.** Bundled guide lists 6 operations: `goToDefinition`, `findReferences`, `hover`, `goToImplementation`, `documentSymbol`, `workspaceSymbol`. Exposed only when `lsp_tools` / `GROK_LSP_TOOLS=1` **and** merged LSP config is non-empty. Isolated `HOME`+`GROK_HOME` `inspect`: no `lsp.json` → `lspServers: []`; flag without file → still `[]`; project `.grok/lsp.json` → server listed, `untrusted: true`. **New in 1.0.4 and not a TUI door:** `code_nav` / `codebase_indexing` is grok-web only (`code navigation is currently only enabled for grok-web clients`; client must advertise `x.ai/codeNavigation.enabled`). | Invented env `GROK_TACHYON_INVENTED=1` absent from `inspect` JSON. Invented method names absent from the binary. `--tools` accepts any string (not a catalog). |
| Codex | 0.147.0 | 2026-08-17 | **None.** `codex features list` (104 flags) has no `lsp` / `language_server` / `workspace_symbol`. Exact tokens `lsp`, `LSP`, `workspaceSymbol`, `goToDefinition`, `textDocument/definition`, `textDocument/hover` are absent from the musl binary. `codex app-server generate-json-schema --experimental` has no LSP method (`rg -i lsp` hits are the substring inside `ToolSpec`). `code_mode` is not LSP. | Invented feature names empty. No feature starting with `lsp`. |

**Stop condition (brief):** if Codex 0.147.0 had gained native code intelligence, this spec would not be written. It did not. The decision to build stays with this contract.

Journal receipt: `t-4fbbb2` / `j-b411f585abbd`.

## Why the Bridge, not the plugin engine

Located 2026-08-17 (none of the `src/` paths in the 2026-07-31 card body exist):

- Plugin MCP still renders only Claude (`.mcp.json`) and Codex (`[mcp_servers.<name>]`) — `packages/engine/src/plugins/mcp.ts`.
- Grok’s plugin adapter leaves `mcpRel` deferred: wiring the Codex codec would install a shape Grok does not load — `packages/engine/src/plugins/adapters/grok.ts`.
- The Bridge reaches Claude, Codex and Grok. `registerTools` runs per MCP session (`packages/bridge/src/Bridge.ts`). A setting flip already closes live sessions and announces `tools/list_changed` without respawn (`Workspace.ts` on `settings.companion.tabTools`; `Bridge.forceToolListRefresh`).

Pi is out of scope (SDD 508). The Bridge argument stands because it reaches the three first-class runtimes, not because Pi comes along.

## Design

### Opt-in gate, listing ≠ execution

Mold: `settings.companion.tabTools` (SDD 414).

- Setting in `tachyon.yml` (proposed: `settings.codeIntelligence.tools`, boolean, default absent/false).
- Predicate on `Workspace` threaded into `BridgeDeps`.
- `if (deps.codeIntelligenceToolsEnabled?.())` wraps the four `registerTool` calls.

Listing and execution are **separate** gates. Precedent, still true: `companionBrowserPaired` is checked at call time and is explicitly *“not used to hide tools from the list”* (`packages/bridge/src/tools/shared.ts`). `user_browser_*` register when `tabTools` is on; an unpaired call returns an actionable error (`packages/bridge/src/tools/user-browser.ts`).

Same shape here: without a language server for that file, the tool exists and returns how to install or enable one. No binary is packaged.

### Four tools, grouped by input shape

One enum of all operations would lie in the schema. Names are `code_*`, not `lsp_*` — the agent does not need the transport. Precedent: `user_browser_*`.

| Tool | Input | Operations |
|---|---|---|
| `code_symbol_at` | `file`, `line`, `col`, `operation` | `definition`, `implementation`, `references`, `hover`, `incoming_calls`, `outgoing_calls` |
| `code_file_symbols` | `file`, `operation` | `symbols`, `diagnostics` |
| `code_search_symbols` | `query` | workspace symbol search |
| `code_intel_status` | none | live servers, covered extensions, what is missing |

### Stack-agnostic routing

Route by **file extension at call time**, not by a one-shot project stack.

`detectStack` in `apps/vscode-extension/src/init/initLogic.ts` is first-match-wins by design (`package.json` then `composer.json` then `Cargo.toml` …). Reuse its inventory of manifests; do not reuse the first-match winner. All matches contribute candidate servers. `.ts` answers if a TypeScript server is configured and alive; `.php` without a server returns an installable next step.

### Host pool, keyed by resolved worktree root

Not by agent. Several agents on the same path share one pool. An isolated worktree has its own. A fork already gets a new worktree, so it gets a new pool with no special case.

Lazy start. Idle eviction. **No document sync** — read from disk. Agents on the same path share the disk, so there is no per-agent overlay to contaminate.

### The pool yields, never vetoes

Worktree occupancy is still only an agent (`WorktreeOccupancy = { state, agent, cwd }` in `packages/engine/src/worktree/WorktreeManager.ts`). A language server holding the directory is an invisible occupant: on POSIX, `git worktree remove` can succeed and leave the server serving deleted inodes.

The pool must not become a fifth occupancy reason. That type names an agent in the refusal UI; a cache pretending to be an agent would lie.

Eviction runs **inside the same `withLock(rec.path, …)` as removal**, **after** occupancy has passed, **before** git removes. Authority (`hygieneAuthority.ts`) still answers only “may this actor ask?”. Material safety (`classifyManagedWorktree`) is unchanged. The pool is 100% derived from disk, so it is never the thing whose loss makes a removal unsafe.

`force` is not a separate door. Occupancy is always fail-closed before force is considered (spec 392, `WorktreeManager.remove`).

### The hole hygiene does not govern

Reload or crash of the extension: no worktree is removed, so no layer fires. The pool dies with the host; language-server processes do not. **Orphan scan on host start is a required test case.**

## Actor × trigger (this list is the test list)

Named the same way in implementation tests. A comment claiming a single entry point is not a test.

| Actor | Trigger | Effect |
|---|---|---|
| Interface | flip `settings.codeIntelligence.tools` in Control / `tachyon.yml` | catalog re-registers via `forceToolListRefresh`; no agent respawn |
| Agent | equivalent `runtime-api` / `write_tachyon_config` action | same door, same effect |
| Agent / Interface | `remove_worktree` | evict the pool for that resolved root **after** occupancy passes, **before** git remove |
| Interface | `force: true` on the same remove | **not a separate door** — occupancy already fail-closed |
| Tachyon | `reconcile_worktree_hygiene` | same evict-then-remove door |
| Interface / Agent | `dismiss_agent` / `kill_agent` | **does not evict**. The worktree outlives the agent; the pool stays for restart and idles out |
| Tachyon | spawn / restart / resume on the **same** path | reuse the existing pool; do not reindex |
| Tachyon | fork | new worktree → new pool; no special case |
| Tachyon | extension reload / crash / host start | **orphan scan**; kill language-server processes whose pool is gone |

## Acceptance criteria

- [x] Native capacity of Claude 2.1.233, Grok 1.0.4 and Codex 0.147.0 is recorded above with version, date and a declared negative control.
- [x] Codex 0.147.0 did not gain native code intelligence; the spec proceeds.
- [ ] **Scenario: opt-in lists the four tools**
  - **Given** `settings.codeIntelligence.tools` is true
  - **When** a Claude, Codex or Grok agent lists Bridge tools
  - **Then** `code_symbol_at`, `code_file_symbols`, `code_search_symbols` and `code_intel_status` appear, and no `lsp_*` name is registered
- [ ] **Scenario: default does not list them**
  - **Given** the setting is absent or false
  - **When** any agent lists Bridge tools
  - **Then** none of the four names appear
- [ ] **Scenario: flip refreshes without respawn**
  - **Given** live Bridge sessions
  - **When** the human (or the equivalent agent config action) flips the setting
  - **Then** sessions are closed, `tools/list_changed` is announced, and the next list matches the new value
- [ ] **Scenario: missing server is listed and fails closed with a next step**
  - **Given** the setting is on and no language server covers `.php`
  - **When** an agent calls `code_symbol_at` on a `.php` file
  - **Then** the tool is in the list and the call returns an actionable “how to install / configure” payload, not a hidden-tool miss
- [ ] **Scenario: covered file answers**
  - **Given** a live TypeScript language server in the pool for this worktree
  - **When** an agent calls `code_symbol_at` with `operation: definition` on a `.ts` symbol
  - **Then** the result is a location from that server, read from disk (no document overlay)
- [ ] **Scenario: two agents on one path share the pool**
  - **Given** two live agents whose resolved cwd is the same worktree root
  - **When** both call `code_file_symbols`
  - **Then** they hit one pool keyed on that root, not two server processes
- [ ] **Scenario: isolated worktree does not share**
  - **Given** a fork (new worktree)
  - **When** the child calls a `code_*` tool
  - **Then** it uses a different pool than the parent
- [ ] **Scenario: remove evicts, occupancy still wins**
  - **Given** a pool is live for a managed worktree
  - **When** `remove_worktree` runs and occupancy is clear
  - **Then** the pool is dumped under the same lock before `git worktree remove`, and the refusal UI never names the pool as an agent
- [ ] **Scenario: dismiss does not evict**
  - **Given** an agent using a shared worktree is dismissed
  - **When** another agent (or a restart) on that path calls `code_*`
  - **Then** the existing pool is reused
- [ ] **Scenario: host start reaps orphans**
  - **Given** language-server processes left behind after an extension crash
  - **When** the host starts
  - **Then** those processes are found and killed; a test covers this door by name
- [ ] If a typed parity dimension is added, it is a new `PARITY_DIMENSIONS` key (not row 19 / `design_mode_chat_reply`), every cell has `projection` + `runtime`, `runtime: wired` is impossible, and `unmeasured` carries `needed`.

## Non-goals

- Product code in this delivery. No tool, no setting, no pool, no `parity.ts` edit.
- Mutation (`rename`, `codeAction`). No native runtime exposes it to the agent as a first-class tool, and it would collide with the runtime’s own edit tool and with the verify gate.
- Push diagnostics. Tachyon does not intercept edits; diagnostics start as pull (`code_file_symbols` / `diagnostics`).
- Packaging a language-server binary.
- Projecting `.grok/lsp.json` (withdrawn, `t-52964c`). Ambient Grok input stays refused.
- Claiming dimension 19. That row is Design Mode chat reply.
- Pi, OpenCode, Hermes.
- Document sync / in-memory overlay.

## Open questions

These block implementation, not this spec. Owner: the implementing agent, with a note back to `t-4fbbb2` before coding the pool.

1. **Staleness without document sync.** The LSP assumes `workspace/didChangeWatchedFiles`. Options: watcher per pool (accurate, multiplies inotify); opportunistic `stat` on the consulted file (cheap, misses transitive); reopen the document per query (always correct on that file, throws away the index). Lean weak: opportunistic, then measure whether `findReferences` after editing a dependency is the case that makes the tool worth having.
2. **Per-server queue and timeout.** N agents serialize on one process. A large `workspaceSymbol` can take seconds. The tool must look occupied, not stuck.
3. **Global memory cap.** 10 Rust worktrees = 10× rust-analyzer. Need an LRU of whole pools. The number is a product decision (global vs per-pool) and is not deduced here. Precedent: Claude 2.1.208’s “LSP documents staying open indefinitely (now LRU with 50-doc cap)”.
