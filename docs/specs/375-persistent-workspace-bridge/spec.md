# 375 — persistent-workspace-bridge

_Created 2026-07-13._

**Status:** shipped
**Closure:** Shipped in `8625ab46` plus installed dogfood of VSIX `0.55.97`: the persistent Bridge proxy runs under user systemd on Linux/WSL, survives Extension Host crash/reload with the same PID/instance/port, reattaches a new backend, and authenticated MCP calls resume on the stable endpoint.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

The Tachyon Bridge and the workspace engine currently live inside VS Code's Extension Host. Extension
`deactivate()` disposes every `Workspace`, and `Workspace.dispose()` closes the Bridge listener. A window reload,
Extension Host crash, accidental window close, or extension upgrade therefore cuts every running agent off from
coordination even though its tmux session survives. Calls may hang instead of returning an honest transport error,
and board writes attempted during the outage are not persisted.

Make the public Bridge listener a persistent local proxy whose lifecycle is independent from any editor window.
The current workspace engine remains in the Extension Host and registers an ephemeral private backend whenever it
is available. Reloading, crashing, closing, or upgrading the editor must not kill or change the public endpoint.
During the bounded gap without an engine, calls fail promptly with `HOST_UNAVAILABLE`; after activation, the same
agent client works again without restart or reconfiguration. Stopping the proxy is an explicit lifecycle action;
ordinary UI disposal only detaches its backend.

## Acceptance criteria

- [x] **Scenario: VS Code window reload does not interrupt the Bridge**
  - **Given** a running workspace service and an agent with a working Bridge client
  - **When** the VS Code window reloads and its old Extension Host deactivates
  - **Then** the same proxy PID/instance and public listener remain alive
  - **And** calls during the gap fail promptly with `HOST_UNAVAILABLE`
  - **And** the new Extension Host registers its backend without restarting agents or changing their Bridge endpoint
- [x] **Scenario: Extension Host crash or accidental window close does not interrupt coordination**
  - **Given** running agents and no explicit stop request
  - **When** the Extension Host crashes or every editor window for the workspace closes
  - **Then** the public Bridge listener remains owned by the same proxy
  - **And** calls return a bounded `HOST_UNAVAILABLE` response until an Extension Host reconnects; they never
    pretend success or hang
- [x] **Scenario: editor reopen attaches to the existing service**
  - **Given** the workspace proxy survived without an editor
  - **When** VS Code opens the workspace again
  - **Then** the extension validates workspace identity, protocol version and proxy incarnation before registering
    its private backend
  - **And** agents resume through the same public endpoint
- [x] **Scenario: only an explicit lifecycle operation stops the service**
  - **Given** a healthy workspace service
  - **When** a user or authorized agent invokes Stop Bridge
  - **Then** the operation is authenticated, audited, bounded, drains or refuses in-flight work according to a
    declared policy, and terminates the exact service incarnation
  - **And** reload, deactivate, dispose, folder removal and client disconnect never call that stop path
- [x] **Scenario: concurrent starters elect one service**
  - **Given** no live service and two editor windows or clients open the same canonical workspace concurrently
  - **When** both try to ensure the service exists
  - **Then** an atomic ownership record elects exactly one workspace service and one listener
  - **And** the loser attaches to the winner without using an unrelated fallback port
- [x] **Scenario: stale ownership is recovered without killing an unrelated process**
  - **Given** a persisted service record whose PID, process start identity, workspace identity or listener proof is
    stale or inconsistent
  - **When** a client attempts attachment or recovery
  - **Then** it refuses ambiguous ownership, never signals a PID by number alone, and provides a bounded explicit
    recovery action
- [x] **Scenario: Bridge requests fail promptly during a real service outage**
  - **Given** the independent service is actually unavailable
  - **When** an MCP client calls a Bridge tool
  - **Then** the client receives a bounded transport/service error and the request cannot remain pending forever
- [x] **Scenario: upgrades preserve or deliberately migrate the service**
  - **Given** a running service using an older compatible or incompatible protocol
  - **When** a newer extension attaches
  - **Then** compatible clients continue without restart, while an incompatible migration requires an explicit,
    visible service restart and preserves durable state
- [x] The persistent service runs locally, binds only to loopback, preserves current per-agent authentication and
  workspace scoping, and does not introduce a cloud dependency.
- [x] A durable service descriptor contains no plaintext bearer token and is written atomically with restrictive
  permissions.
- [x] Existing tmux agents remain usable during migration, and legacy embedded-Bridge mode has a bounded rollback
  switch until dogfood closes the persistent path.

## Non-goals

- Running AI agents without tmux or changing runtime commands.
- Moving workspace artifacts out of the workspace as a storage-cleanup strategy.
- Running Bridge tools while no Extension Host is connected; the persistent proxy returns `HOST_UNAVAILABLE`.
- Remote/network Bridge access; the service remains machine-local and loopback-only.
- Solving Delivery governance, ProcessFence or general artifact cleanup in this spec.
- Treating a listening port alone as health; service identity and a functional tool probe are required.

## Open questions

- Agent-authorized service stop is deferred until a coordinator-only authorization boundary exists; v1 exposes the
  explicit user command and keeps Restart Bridge explicit.
- A future headless engine may replace the proxy/backend split, but is not required to close the reload failure.
