# Tachyon — System Design: monorepo, engine e shell

_Originated in a 2026-06-18 Claude Code ↔ Codex deliberation (pin `p-3ccfd1`). Status: **IMPLEMENTED
AND LIVING** — specs 233/234 established the host boundary and spec 382 shipped the persistent engine /
shell split. This document records the current architecture plus remaining product-boundary work._

## 1. Goal

**The engine owns orchestration; shells own presentation and host APIs.** Concretely: *the engine code
must not be able to know VS Code exists.* The shipped VS Code extension is the current human shell and
bootstrap/distribution mechanism; it connects to a persistent engine through explicit host and control
protocol boundaries. A future CLI, other-IDE plugin or web shell should connect through those boundaries,
not fork orchestration logic. Decoupling is enforced mechanically, not by convention.

The boundary delivers two benefits: (a) **runtime continuity and testability** — the engine can run and be
tested headlessly; (b) **portability** — a second shell becomes an adapter/client instead of a fork. These
are current properties, not a deferred refactor goal.

**AI runtime parity** (Claude / Codex / OpenCode / Grok / …) is **not** this design’s engine/shell split —
it is living product documentation: [docs/runtimes/parity.md](./runtimes/parity.md). Capability parity
via each CLI’s **native** mechanisms (MCP, resume, harness, hooks), not byte-identical protocols.

## 2. Current state (verified, not assumed)

The split is shipped and its source ownership is represented by npm workspaces:

- `packages/engine/src/engine-service/daemonMain.ts` boots the persistent engine process; `engineService.ts`,
  `controlServer.ts` and the event journal expose its lifecycle and state.
- `packages/engine/src/workspace/Workspace.ts` is the engine composition root and imports no `vscode`.
- `packages/engine/src/workspace/EngineHost.ts` is the shell-neutral host contract;
  `DaemonEngineHost.ts` supplies headless behavior. The former `src/workspace/VsCodeHost.ts` had no
  importer and was removed; VS Code services are owned directly by the app modules that consume them.
- `apps/vscode-extension/src/shell/WorkspaceClient.ts` and `WorkspaceShellHandle.ts` are client-side shell boundaries. The handle
  is intentionally ephemeral and does not own managers, stores, the Bridge or agent lifecycle.
- `packages/engine/src/engine-service/protocol.ts` plus `controlClient.ts`/`controlServer.ts` form the typed engine-shell
  transport; editor-only requests are brokered explicitly.
- tmux, agents, tasks, Delivery/worktrees, validation, schedules and Activity remain engine state.
  The Bridge is a transport package composed against the engine-owned `WorkspaceBridgePort`; closing
  or reloading the editor does not transfer engine state ownership back to the shell or transport.

The current packaging still ships engine and shell together in the VSIX, and VS Code remains the only
distributed human shell. Engine-first describes the ownership boundary, not a claim that a standalone
Tachyon CLI or web product already ships.

### 2.1 Workspace layout

```text
package.json                         orchestration, workspaces, gates; no product manifest
apps/vscode-extension/               extension manifest, activation, VS Code hosts, shipped auxiliary entries
packages/engine/                     persistent engine and shell-neutral protocols
packages/bridge/                     HTTP/MCP transport and product composition root
packages/shared/                     runtime vocabulary used by engine and browser
packages/webview-ui/                 the 27 browser entrypoints and their UI dependencies
src/                                 17 repository-support modules + 8 compatibility shims
```

The root declares `apps/*` and `packages/*`; scripts discover workspaces from that declaration. Package
imports use workspace names. A relative import may not escape its workspace, and a named workspace import
must be declared in the importing manifest. `check:package-boundary` enforces both rules with an empty
exception list. `check:engine-boundary` separately forbids `vscode` from `packages/engine`.

## 3. The boundary — engine / host-port / shell

Four buckets, not two:

- **Engine** (no `vscode`, ever): `Workspace`, `AgentManager`, tmux/control-mode, pipelines,
  `Scheduler`, `AttentionMonitor`/`LifecycleMonitor`, ledgers, `WorktreeManager`, `HarnessManager`, config
  load + mutation. Token **policy** (auth on/off) is engine.
- **Transport** (depends on engine, never the reverse): `packages/bridge` implements HTTP/MCP,
  authentication/rebind mechanics and the engine-declared `WorkspaceBridgePort`. Its `daemonMain.ts`
  is the product composition root that selects this transport and invokes the transport-neutral daemon
  core in `packages/engine/src/engine-service/daemonMain.ts`.
- **Host-port** (an interface the engine calls; each host implements it): one-way notices/focus, file
  watching, optional terminal presentation, settings, storage/secrets and workspace-change events.
  Two-way editor interactions are explicit shell/UI requests, not hidden window calls in engine code.
- **Shell** (owns `vscode`, never imported by the engine): activation + command registry, the sidebar tree
  + webviews (Studio/Inspector), editor terminals, `vscode.diff` / settings UI / walkthroughs / clipboard /
  open-document.

The dependency direction is mechanically enforced: `@tachyon/bridge` declares `@tachyon/engine`, while
`@tachyon/engine` does not declare `@tachyon/bridge`. `check:package-boundary` therefore rejects any
engine import of the transport, and the engine→bridge ruler remains at zero.

## 4. Host ports — small and composed, not one fat object

`EngineHost` is implemented as one composed interface with focused groups rather than a grab-bag of VS Code
objects:

- **UI notices/focus** — one-way facts and optional actions; interactive editor workflows remain shell requests.
- **File watch** — root/glob/events/callback; `DaemonEngineHost` supplies headless polling where necessary.
- **Settings** — effective values plus optional scope inspection.
- **Storage + secrets** — host-owned durable paths/state and machine-local secret custody. Token *path/custody*
  is host policy; Bridge authentication semantics remain engine policy.
- **Terminal presentation** — optional. A daemon can run with no editor tabs; the VS Code app owns the native
  terminal presentation in `apps/vscode-extension/src/presentation/Terminals.ts`.
- **Workspace events** — typed invalidation signals consumed by shell projections.

`DaemonEngineHost` implements the headless port. The shipped app uses the control protocol and focused VS Code
services instead of constructing the retired, unconsumed `VsCodeHost` aggregate.

## 5. The Bridge contract — the loose seam that already ships

There are **two** integration depths, and both seams exist today:

1. **Shell client** — attach through the engine control protocol (`WorkspaceClient` / `controlClient`) and
   render state/events. Host-only editor operations travel as explicit brokered requests.
2. **Loose MCP client** — anything that speaks MCP: `@tachyon/bridge` exposes orchestration as tools over HTTP
   (`spawn_agent`, `list_agents`, `write_input`, `complete_node`, …). Any MCP client drives a running
   Tachyon with **no VS Code at all** — this is exactly how a codex pipeline node calls `complete_node`.

The Bridge is the shipped runtime-neutral control surface; the engine owns only the port it needs from a
transport. A second transport can implement and compose that port outside `packages/engine`; the deep host
port remains for shells that also render state and own terminals.

## 6. State model — snapshots + events, not a render tree

The engine exposes **plain state** (`pipelines.allRuns()`, `manager.list()`, attention state, bridge URL —
the sidebar already reads exactly these, `Sidebar.ts:282`) plus **change events** (`onViewsChanged(view)`).
The shell owns its own view model. **Non-goal:** a generic "render tree" abstraction in the engine — each
shell builds its own tree/UI from the snapshots.

## 7. Managed-entry terminal model — tmux is the substrate

Managed entries are backed by **tmux sessions**; they persist across a shell restart regardless of the UI.
An AI agent and a terminal/dev server share this lifecycle substrate, but only the AI-backed entries are
agents. A "terminal pane" is a *shell-owned view* onto a tmux session via the `TerminalPort`. The engine
never owns a pane; it owns the session (through `TmuxService`).

### 7.1 Spawn-time injection is ADDITIVE, never override (invariant)

At spawn/restart/resume the engine composes the agent's command and layers Tachyon wiring on top of the
user's declaration. The native mechanism differs by runtime: Claude uses additive MCP/settings files, Codex
uses config overrides/private home, OpenCode uses scoped XDG/config, and Grok/Hermes use private runtime homes
with generated Bridge entries. Generated private configs preserve user model/provider settings while keeping
Tachyon-owned isolation semantics explicit; bearer tokens remain environment references.

Session-ownership hooks are a separate capability. Where a runtime has a verified hook adapter they record
`{agent → current session}` for Activity/resume attribution. Runtimes without a user-hook materializer reject
`harness.hooks` rather than silently claiming delivery.

**Guarantee:** `--settings` is a merge layer — claude unions the hook command lists across all active sources
(user `~/.claude/settings.json`, project `.claude/settings.json`, local, each `--settings`), so for one event ALL
of them run; our injected SessionStart does **not** displace the user's. Verified live (claude 2.1.185): a project
hook and our `--settings` hook both fired. No `~/.claude`/repo `.claude/` file is mutated. Harness/isolated agents
are unaffected — `--strict-mcp-config` scopes MCP only, `CLAUDE_CONFIG_DIR` redirects the user-settings home but
the project hooks + our layer still load, and the harness materializer passes no `--settings` (no collision).
Both injectors **skip self-managed commands** (the user's own `--resume`/`--continue`) and a command that already
sets the same flag (with an advisory). The only behavior change is if the user's command opts into
`--setting-sources` to restrict the merge set — which Tachyon never injects.

## 8. File watching

The engine watches `tachyon.yml` and `.tachyon/*` for config and state reload. The `EngineHost.watch` seam lets
the VS Code adapter use editor facilities while `DaemonEngineHost` uses the headless polling watcher. The
engine consumes events, not a `vscode.FileSystemWatcher`, so shell restarts do not redefine state ownership.

## 9. Localization

Engine-facing localization goes through `host.t(...)`; high-value UI interactions use typed protocol payloads
and brokered requests. The shell decides how to render notices, prompts and webviews. New engine code must not
reintroduce `vscode.l10n` or window APIs.

## 10. Testing strategy

The primary near-term payoff. A `FakeHost` makes `Workspace.create / start / rebuildWatches /
startPipeline` unit-testable without Electron — retiring the "re-compose Workspace minus vscode"
duplication in the integration tests. Rule: **engine logic → unit tests with `FakeHost`; VS Code
integration tests only for genuine shell behavior** (tree rendering, terminal focus, layout).

## 11. Packaging and package boundaries

The Marketplace VSIX is built from `apps/vscode-extension/package.json` and packages the VS Code shell,
engine bundle and engine bootstrap together. The root remains the install/build/gate unit and the product keeps
one version and one VSIX. At runtime the engine is a separate persistent process. The npm workspaces are
private source/build boundaries, not independently published products; there is no standalone human CLI shell.

The measured ownership is 368 TypeScript sources in `packages/engine`, 45 runtime/source files in
`packages/shared` (including four `.cjs`), 203 TypeScript sources in `packages/webview-ui`, and 164
TypeScript sources in the VS Code app. These physical counts exceed the original runtime closures because
type-only concept modules do not emit JavaScript but are required for each package to compile independently.

## 12. Remaining product-boundary work

1. Keep protocol compatibility and engine-bundle migration safe across extension upgrades.
2. Continue replacing editor-shaped payloads with typed shell-neutral events/requests.
3. Prove a second human shell (CLI, another IDE or web) before adding independent publication/versioning.
4. Preserve headless test coverage and the `vscode` import boundary as engine capabilities grow.
5. Retire the eight root compatibility shims tracked by `t-31bedf`; the other 17 root sources are
   repository-only dev/test/measurement support, not a latent product package.

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
