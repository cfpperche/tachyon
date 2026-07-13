# 375 — persistent-workspace-bridge

_Created 2026-07-13._

**Status:** draft
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

Make the workspace Bridge a persistent local service whose lifecycle is independent from any editor window. The
service, not the VS Code extension, owns the headless workspace engine and the canonical Bridge listener. VS Code
is a reconnecting presentation client. Reloading, crashing, closing, or upgrading the editor must not stop the
service or interrupt agent-to-agent, Task, Delivery, handoff, verification, or lifecycle tools. Stopping the
service is an explicit, auditable user/authorized-agent action; ordinary UI disposal only detaches that client.

## Acceptance criteria

- [ ] **Scenario: VS Code window reload does not interrupt the Bridge**
  - **Given** a running workspace service and an agent with a working Bridge client
  - **When** the VS Code window reloads and its old Extension Host deactivates
  - **Then** the same workspace service PID/instance and preferred listener remain alive
  - **And** the agent can complete a durable Bridge write before the new Extension Host attaches
  - **And** the new Extension Host reconnects without restarting agents or changing their Bridge endpoint
- [ ] **Scenario: Extension Host crash or accidental window close does not interrupt coordination**
  - **Given** running agents and no explicit stop request
  - **When** the Extension Host crashes or every editor window for the workspace closes
  - **Then** agent-to-agent, Task, Delivery, handoff, verification, and lifecycle tools remain operational
  - **And** UI-only actions return a bounded `UI_UNAVAILABLE` result or use an explicitly durable queue; they never
    pretend success or hang waiting for an editor
- [ ] **Scenario: editor reopen attaches to the existing service**
  - **Given** the workspace service survived without an editor
  - **When** VS Code opens the workspace again
  - **Then** the extension validates workspace identity, protocol version, service incarnation and authentication
    before attaching
  - **And** it renders the existing fleet/state rather than creating a competing engine or listener
- [ ] **Scenario: only an explicit lifecycle operation stops the service**
  - **Given** a healthy workspace service
  - **When** a user or authorized agent invokes Stop Bridge
  - **Then** the operation is authenticated, audited, bounded, drains or refuses in-flight work according to a
    declared policy, and terminates the exact service incarnation
  - **And** reload, deactivate, dispose, folder removal and client disconnect never call that stop path
- [ ] **Scenario: concurrent starters elect one service**
  - **Given** no live service and two editor windows or clients open the same canonical workspace concurrently
  - **When** both try to ensure the service exists
  - **Then** an atomic ownership record elects exactly one workspace service and one listener
  - **And** the loser attaches to the winner without using an unrelated fallback port
- [ ] **Scenario: stale ownership is recovered without killing an unrelated process**
  - **Given** a persisted service record whose PID, process start identity, workspace identity or listener proof is
    stale or inconsistent
  - **When** a client attempts attachment or recovery
  - **Then** it refuses ambiguous ownership, never signals a PID by number alone, and provides a bounded explicit
    recovery action
- [ ] **Scenario: Bridge requests fail promptly during a real service outage**
  - **Given** the independent service is actually unavailable
  - **When** an MCP client calls a Bridge tool
  - **Then** the client receives a bounded transport/service error and the request cannot remain pending forever
- [ ] **Scenario: upgrades preserve or deliberately migrate the service**
  - **Given** a running service using an older compatible or incompatible protocol
  - **When** a newer extension attaches
  - **Then** compatible clients continue without restart, while an incompatible migration requires an explicit,
    visible service restart and preserves durable state
- [ ] The persistent service runs locally, binds only to loopback, preserves current per-agent authentication and
  workspace scoping, and does not introduce a cloud dependency.
- [ ] The service owns the headless workspace engine required by Bridge tools; a detached HTTP proxy that depends on
  live Extension Host callbacks does not satisfy this spec.
- [ ] A durable service descriptor contains no plaintext bearer token and is written atomically with restrictive
  permissions.
- [ ] Existing tmux agents remain usable during migration, and legacy embedded-Bridge mode has a bounded rollback
  switch until dogfood closes the persistent path.

## Non-goals

- Running AI agents without tmux or changing runtime commands.
- Moving workspace artifacts out of the workspace as a storage-cleanup strategy.
- Making UI-only VS Code operations available while no editor is connected.
- Remote/network Bridge access; the service remains machine-local and loopback-only.
- Solving Delivery governance, ProcessFence or general artifact cleanup in this spec.
- Treating a listening port alone as health; service identity and a functional tool probe are required.

## Open questions

- Should the service be one process containing both supervisor and engine, or a tiny stable supervisor that restarts
  a versioned engine child? Resolve with a crash/reload spike before the implementation plan.
- Which current `EngineHost` capabilities must move to a headless implementation, and which tools must be classified
  as UI-only? Resolve by inventorying every Bridge dependency and tool.
- What is the explicit stop policy while agents or Delivery leases are active: refuse by default, drain, or require a
  separate force operation? Maintainer decision required before implementation.
- What compatibility window and rollback flag are required for the embedded Bridge? Resolve in the rollout plan.
