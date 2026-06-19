# Tachyon — System Design: decoupling the engine from the UI

_Co-authored 2026-06-18 by a Claude Code ↔ Codex deliberation (pin `p-3ccfd1`). Status: DESIGN (no code
yet). This is the target architecture + migration path; it is not a spec — a spec is cut from it when a
concrete second host (or the testability win alone) justifies the first PR._

## 1. Goal

**The engine owns orchestration; shells own presentation and host APIs.** Concretely: *the engine code
must not be able to know VS Code exists.* A second shell — another IDE plugin, a CLI/daemon, a web UI —
"just connects to the engine" because the engine depends only on a small set of **host ports**, never on
`vscode`. Decoupling is enforced mechanically (a CI import guard), not by convention.

This is worth doing for two reasons, in order: (a) **testability today** — `Workspace`, the orchestrator,
can't enter the unit suite because it imports `vscode`, so tests re-compose pieces around it (e.g.
`test/unit/verifyGate.integration.test.ts:80` duplicates the `Workspace.runVerify` composition "minus the
vscode toast/ledger I/O"); a `FakeHost` makes `Workspace` directly unit-testable. (b) **portability** — a
new shell becomes a thin adapter, not a fork.

## 2. Current state (verified, not assumed)

The engine is now fully decoupled (specs 233/234 shipped). **Only the shell imports `vscode`:**
`extension.ts`; `presentation/{Sidebar,Terminals}.ts`; `webview/{AgentForm,ServerInspector}.ts`; and
`workspace/{VsCodeHost,notify}.ts`. `Workspace.ts` + all managers import zero `vscode`, enforced by the
`check:engine-boundary` CI guard.

Everything substantive is **already `vscode`-free**: `TmuxService` + `ControlModeClient` (the tmux
substrate), `AgentManager`, `Bridge` (+ `bridge/tools.ts`, the MCP surface), `PipelineManager` /
`RunLedger` / `runState` / `loadPipeline` / `doneContract` / `preflight`, `WorktreeManager`,
`SessionLedger`, `AttentionMonitor`, `LifecycleMonitor`, `CommandRunner`, `RunbookRunner`, `Scheduler`,
`PinStore`, `ProposalStore`, `HarnessManager`, `config/loadConfig`. `Workspace` constructs all of these as
plain objects (`Workspace.ts:179`+).

The remaining seam is **`Workspace.ts` itself**. Its DI surface is already tiny — `WorkspaceDeps` is just
`{ context, onViewsChanged }` (`Workspace.ts:69`). The coupling is in the *body*, not the deps:

| vscode usage in `Workspace.ts` | count | nature |
|---|---|---|
| `vscode.l10n.t(...)` | ~92 | i18n of user-facing strings (shallow) |
| `vscode.window.*` (showInputBox / showWarningMessage / tabGroups) | ~8 | prompts + editor layout |
| `createFileSystemWatcher` + `RelativePattern` | ~6 | watch `tachyon.yml` / `.tachyon/*` |
| `commands.executeCommand` | 2 | invoke a command |
| `getConfiguration`, `Uri`, `ExtensionContext`, `Disposable` | ~5 | settings, paths, types |

So the move is a **bounded extraction**, not a rewrite: lift the ~21 non-i18n touchpoints behind ports,
route the 92 strings through a port, and make `Workspace` import-free of `vscode`.

## 3. The boundary — engine / host-port / shell

Three buckets, not two:

- **Engine** (no `vscode`, ever): `Workspace`, `AgentManager`, `Bridge`, tmux/control-mode, pipelines,
  `Scheduler`, `AttentionMonitor`/`LifecycleMonitor`, ledgers, `WorktreeManager`, `HarnessManager`, config
  load + mutation. Token **policy** (auth on/off) is engine.
- **Host-port** (an interface the engine calls; each shell implements it): notification + prompting, file
  watching, **terminal control** (reveal/close/active/inspect), global-storage **path**, host settings,
  workspace-change events.
- **Shell** (owns `vscode`, never imported by the engine): activation + command registry, the sidebar tree
  + webviews (Studio/Inspector), editor terminals, `vscode.diff` / settings UI / walkthroughs / clipboard /
  open-document.

The `Bridge` stays **engine**: it is pure HTTP/MCP, its `BridgeDeps` (`bridge/tools.ts:15`) already binds
*engine* capabilities (not UI objects), and its durable state lives in tmux, not VS Code (`Bridge.ts:22`).

## 4. Host ports — small and composed, not one fat object

Migrate *behind a single `EngineHost` adapter first* (speed), then split into focused ports so no consumer
depends on more than it uses. The end-state ports:

- **`UiPort`** — `notify(level, msg)`, `confirm(msg, actions)`, `promptInput(opts)`. (Replaces
  `notify.ts` + `vscode.window` message/input calls.)
- **`TerminalPort`** — `reveal(session)`, `close(session)`, `isActive(session)`, `inspect(session)`. This
  is **not** a file move of `presentation/Terminals.ts`: `Workspace` drives terminals for reveal, active-
  suppression, command/crash inspection (`Workspace.ts:240,351,392,436`); those become port calls, the VS
  Code editor-terminal impl stays in the shell.
- **`FileWatchPort`** — `watch(root, glob, events, cb): Disposable`, plus capability metadata
  (`reliableRecursive`, `supportsGlob`, `source: "vscode" | "node" | "polling"`). The engine consumes watch
  events and must NOT assume `fs.watch` parity. This mirrors the existing injected-watcher pattern in
  `WatchController` (`AgentManager.ts:1117`), already documented as testable outside VS Code.
- **`SettingsPort`** — `get(key)` for host settings (`getConfiguration`, max-agents).
- **`StoragePort`** — `globalStoragePath` (today `context.globalStorageUri`, `Workspace.ts:198`) for the
  Bridge token + version state. Token *path* is host; token *policy* is engine.
- **`WorkspaceEvents`** — `onViewsChanged(view)` (already exists) + the typed change events of § 6.

`EngineHost = UiPort & TerminalPort & FileWatchPort & SettingsPort & StoragePort & WorkspaceEvents`. The VS
Code shell provides one object implementing all; a CLI implements `UiPort` as stdio + no-op terminals; a
daemon implements them headlessly.

## 5. The Bridge contract — the loose seam that already ships

There are **two** integration depths, and the loose one exists today:

1. **Deep** — a real shell: import the engine + `Workspace`, implement `EngineHost`, build the UI.
2. **Loose** — anything that speaks MCP: the `Bridge` already exposes orchestration as MCP tools over HTTP
   (`spawn_agent`, `list_agents`, `write_input`, `complete_node`, …). Any MCP client drives a running
   Tachyon with **no VS Code at all** — this is exactly how a codex pipeline node calls `complete_node`.

The Bridge is the runtime-neutral control surface; the deep port is for shells that also render state and
own terminals. The design must keep the Bridge a first-class, shell-independent entry point.

## 6. State model — snapshots + events, not a render tree

The engine exposes **plain state** (`pipelines.allRuns()`, `manager.list()`, attention state, bridge URL —
the sidebar already reads exactly these, `Sidebar.ts:282`) plus **change events** (`onViewsChanged(view)`).
The shell owns its own view model. **Non-goal:** a generic "render tree" abstraction in the engine — each
shell builds its own tree/UI from the snapshots.

## 7. Terminal model — tmux is the substrate

Agents are **tmux sessions**; they persist across a shell restart regardless of the UI. A "terminal pane"
is a *shell-owned view* onto a tmux session via the `TerminalPort`. The engine never owns a pane; it owns
the session (through `TmuxService`).

## 8. File watching

The engine watches `tachyon.yml` and `.tachyon/*` for config/pipeline reload. `fs.watch` is flaky cross-
platform; VS Code's watcher is robust. The `FileWatchPort` lets each host pick its mechanism (VS Code
keeps `createFileSystemWatcher` at `Workspace.ts:869`; headless hosts use chokidar or polling) and declare
its capabilities, so the engine degrades gracefully instead of promising parity it can't keep.

## 9. Localization

PR-1: route the 92 strings through `host.t(key, ...args)` to remove `vscode` from `Workspace` (the visible
case: helpers like `issueMessage` calling `vscode.l10n` directly, `Workspace.ts:101`). **End-state:** the
engine emits **typed events + payloads** for high-value flows (crash, attention, pipeline failure) and the
shell renders the text; migrate hot paths to events incrementally — doing all 92 as typed events at once is
unjustified churn.

## 10. Testing strategy

The primary near-term payoff. A `FakeHost` makes `Workspace.create / start / rebuildWatches /
startPipeline` unit-testable without Electron — retiring the "re-compose Workspace minus vscode"
duplication in the integration tests. Rule: **engine logic → unit tests with `FakeHost`; VS Code
integration tests only for genuine shell behavior** (tree rendering, terminal focus, layout).

## 11. Packaging boundary

Lowest ceremony that still *proves* decoupling:
1. Introduce ports (§ 4) and a `VsCodeHost` adapter.
2. Move the engine under `src/engine/**`.
3. Add a CI script `check:engine-boundary` that **fails on any `vscode` import under `src/engine/**`**
   (the build already has `typecheck` / `test` / `test:integration`, `package.json`; add this guard).

**No published `@tachyon/engine` package yet** — a split only earns its ceremony once a second real host
exists. The lint/CI guard delivers the guarantee without it.

## 12. Migration plan — incremental, behavior-preserving PRs

1. **Ports + `VsCodeHost` (no behavior change, no file moves).** Define `EngineHost`; route `notify`, `t`,
   `getSetting(maxAgents)`, `globalStoragePath`, file watchers, and terminal control through it. The
   adapter is 1:1 with today's calls; the suite stays green. *Safest first PR.*
2. **Make `Workspace.ts` `vscode`-import-free** + add `check:engine-boundary` to CI.
3. **`FakeHost` + Workspace unit tests** (collapse the integration-test duplication).
4. **Move presentation fully to the shell** behind `TerminalPort` (not a bare file move).
5. **(Deferred)** typed-event localization for hot paths; **(deferred)** package split when a 2nd host lands.

## 13. Risks

The live extension has marketplace users — every step is behavior-preserving and independently shippable.
Watch: token path / version storage, config reload + watch behavior, and terminal reveal / focus
(`presentation/Terminals.ts`). Each has an integration test that must stay green across the extraction.

## 14. Non-goals

- A generic UI/render-tree abstraction in the engine (shells own their view model).
- Replacing or re-architecting the Bridge (it's already the runtime-neutral seam).
- Rewriting the managers (they're already `vscode`-free — this is extraction, not a rewrite).
- Publishing an `@tachyon/engine` package before a second host proves its value.
- Abstracting editor-only commands (`vscode.diff`, settings UI, walkthroughs, clipboard, webviews) — those
  are shell concerns, never engine capabilities.

---

### Deliberation record
This design converged from a two-party deliberation. Claude's opening proposed a single `HostPort` + the
engine/shell split + the MCP loose seam + an incremental migration. Codex refined it: **small composed
ports over one fat port** ("the engine cannot know VS Code exists"), **`TerminalPort` rather than moving
`Terminals`**, **file-watch capability metadata**, **testability as the primary near-term justification**,
the precise engine/host/shell trichotomy (Bridge = engine; token path = host), and the safest-first-PR
sequencing. No material dissent remained. Full transcript: `/tmp/codex-sysdesign-out.json`.
