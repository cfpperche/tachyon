# 382 — persistent-engine-shell-boundary — plan

_Drafted from `spec.md` on 2026-07-14._

## Approach

Evolve the current per-workspace persistent Bridge process into a persistent workspace-engine service.
The service constructs `Workspace` once with a daemon implementation of `EngineHost`, owns the public
Bridge endpoint directly, and remains alive under the host's user-service manager.  The extension no
longer creates a local `Workspace`; it ensures the packaged service and attaches a `WorkspaceClient`.

The shell/service seam is a versioned, machine-local protocol with three primitives:

1. `attach/hello` proves canonical workspace identity, protocol range, engine bundle/incarnation and a
   unique shell client id; it also supplies an allowlisted settings/capability snapshot.
2. `snapshot + events` gives the shell plain domain state and monotonic change events.  A missing event
   cursor forces a full resnapshot instead of replaying an ambiguous partial history.
3. `invoke` accepts a closed method id, typed input and operation id.  Domain mutations are idempotent;
   VS Code-only presentation actions are routed to a currently attached capable shell or return
   `UI_UNAVAILABLE`.

Build it in reviewable vertical slices, but do not ship a mixed default.  The worktree may temporarily
contain both adapters while the shell is migrated; final cutover deletes embedded production ownership
and reload-generation repair.  Existing durable `.tachyon/` domain files and agent credentials remain
compatible.

## Key decisions

- **Process separation, not just import separation** — spec 233 already proved the source boundary;
  spec 382 makes the OS process boundary authoritative.
- **Evolve the existing persistent service** — reuse its workspace identity, service election, secure
  control socket, packaging and launcher rather than add a second daemon beside it.  The ephemeral
  Extension Host backend is removed at cutover.
- **One engine per canonical workspace** — preserves today's isolation and multi-root model while making
  concurrent windows clients of one authority.
- **Attach is read/synchronize, never boot/recover** — daemon startup owns `Workspace.create/start` once;
  shell attachment cannot autostart, resume, rebind or reload operational state.
- **A shell protocol distinct from agent MCP** — agents keep the governed Bridge surface and caller
  authentication; the UI gets typed snapshots/events/actions without impersonating an agent.  Both
  adapters call the same engine/application services.
- **Automatic content-addressed engine installation** — the VSIX ships the engine bundle and manifest;
  the shell copies it atomically to a machine-private versioned location, verifies its hash, and asks the
  platform launcher to ensure it.  The daemon never runs from a disposable extension-version directory.
- **Daemon-owned state** — replace `ExtensionContext.globalState`/`SecretStorage` dependencies with an
  atomic per-workspace state store and private secret store.  A narrow shell-authored migration envelope
  imports known legacy keys exactly once.
- **No silent embedded fallback** — fallback would recreate the lifecycle defect.  Startup failures are
  visible and actionable; existing embedded mode may exist only behind an explicit development/rollback
  switch until final cutover, then is removed from production configuration.
- **Engine generation is not shell generation** — shell attach ids/cursors are ephemeral.  Bridge-client
  recovery is triggered only by a proven engine incarnation change.
- **No full Runtime API prerequisite** — migrate the UI through a minimal versioned `WorkspaceClient`
  contract now; the broader t-784bc8 API/CLI program can generalize the same service layer later.

## Interfaces and state

- `EngineBundleManifestV1`: version, protocol range, build provenance, entrypoint hashes.
- `EngineServiceDescriptorV2`: canonical root/hash, service PID/start identity, incarnation, bundle hash,
  public Bridge endpoint, control endpoint and protocol range; no bearer token.
- `EngineShellHelloV1` / `EngineShellSessionV1`: shell id, version, locale, settings projection,
  capabilities, engine identity, snapshot sequence.
- `WorkspaceSnapshotV1`: versioned plain projections needed by existing sidebar/panels; no manager or
  VS Code objects.
- `WorkspaceEventV1`: monotonic sequence, domain kind, affected projection and bounded payload.
- `WorkspaceCommandV1`: closed method id, schema-versioned input, operation id and caller shell id.
- `DaemonEngineHost`: i18n substitution, Node watcher with bounded polling fallback, daemon state/secrets,
  durable notices/events, engine bundle media, no editor execution.
- `WorkspaceClient`: shell-side async interface used by presentation code; local fake for unit tests and
  remote implementation for production.

## Failure behavior

- Shell disappears: expire only its capability/session lease; engine continues.
- Control connection drops: shell reconnects and resnapshots; no operational retry is inferred.
- Event gap/overflow: return `RESYNC_REQUIRED`; never guess or duplicate mutations.
- Engine unavailable: bounded typed error plus Doctor/Retry UX; never start embedded Workspace.
- Duplicate ensure/attach/invoke: service election and operation-id records converge to one result.
- Bundle/protocol mismatch: keep the last verified compatible engine or fail visibly; never execute an
  unverified bundle or overwrite the only rollback copy.
- Engine crash: user-service manager restarts the exact staged bundle, durable engine state rehydrates,
  and the real incarnation change is audited before any client recovery.

## Files touched

- `src/bridge/persistentProxyDaemon.ts`, `PersistentBridgeService.ts`, protocol modules — evolve proxy
  lifecycle into the engine service and version its descriptor/control protocol.
- `src/workspace/DaemonEngineHost.ts`, daemon state/watch/secret modules — new headless host ownership.
- `src/engine-service/**` — bundle manifest, daemon entrypoint, service state, attach/invoke/event server.
- `src/runtime-api/**` — plain snapshot/event/command schemas and engine adapters.
- `src/shell/WorkspaceClient.ts` plus VS Code adapter — attach, resync, capability requests.
- `src/extension.ts` and presentation/webview adapters — consume `WorkspaceClient`, remove production
  `Workspace.create/dispose` ownership.
- `src/workspace/Workspace.ts`, `clientRebind.ts` — daemon startup ownership and removal of shell-generation
  rebind triggers after cutover.
- `esbuild.mjs`, `package.json`, release/provenance scripts — ship and verify the engine bundle.
- focused unit/integration tests and `scripts/dogfood/persistent-engine.mjs`.

## Risks & unknowns

- The shell currently reaches many concrete `Workspace` stores/managers; the inventory must prevent a
  hidden direct dependency from surviving cutover.
- Secret/global-state migration must be one-time, allowlisted and rollback-safe.
- Node file watching must preserve config/task refresh semantics across WSL, Linux, macOS and Windows.
- Multiple windows can duplicate notices or UI requests unless claiming is operation-id-bound.
- A daemon bundle launched from the extension install directory would break upgrades; the content-addressed
  staging proof is a release gate.
- The engine may be absent at OS boot until first Tachyon use.  This spec promises continued operation
  after automatic startup, not workspace discovery before a user has ever opened it.

## Visual impact

No intentional layout change.  The visible changes are connection/upgrade/error states; real installed
dogfood must prove the sidebar/panels resnapshot without flicker, duplication or stale actions after reload.

## Sources consulted

- `docs/system-design.md`; specs 233, 375, 364/380 and task `t-82f4e6`.
- `src/extension.ts`, `src/workspace/{Workspace,EngineHost,VsCodeHost}.ts`.
- `src/bridge/{Bridge,PersistentBridgeService,persistentProxyDaemon,clientRebind}.ts`.
- Existing `workspaceHeadless`, persistent-Bridge, reload-rebind and packaging tests.
