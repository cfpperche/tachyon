# 382 — persistent-engine-shell-boundary

_Created 2026-07-14._

**Status:** shipped
**Closure:** Shipped 2026-07-15 through accepted commit `886880d1`: version 0.56.8/protocol 3 moves the complete workspace engine behind a persistent per-workspace service on Linux/WSL, makes editor reload a detach/attach boundary, stages immutable engine and runtime bytes, preserves no-shell orchestration, and provides identity-bound upgrade/rollback, terminal/notification replay and tmux recovery. Focused acceptance, typecheck, production build, engine-boundary, full verification, packaged dogfood and installed reload evidence are green; macOS remains explicitly unsupported without an embedded fallback.

## Intent

Tachyon's engine is source-decoupled from VS Code, but it is still process-owned by the VS Code
Extension Host.  Spec 375 made the public Bridge endpoint persistent by placing a proxy in front of an
ephemeral in-host backend; it deliberately did not move `Workspace` or its managers out of the editor.
Consequently Reload Window still destroys and reconstructs the operational engine, reloads state,
bumps a Bridge-client generation, and may stop/resume agents merely to repair stale MCP clients.  The
installed 0.56.3/0.56.4 dogfood showed that this lifecycle boundary creates destructive races and makes
an editor UI action operationally significant.

Move one complete Tachyon workspace engine into a persistent, machine-local service whose lifecycle is
independent from every editor window.  The VS Code extension becomes a shell client: it installs and
starts the bundled service automatically, attaches for snapshots/events/actions, renders UI, and
detaches on reload or close.  Agents, Bridge tools, Tasks, Delivery, schedules, monitors, ledgers and
workspace watchers remain owned by the same engine process while shells come and go.

Done means VS Code reload is an idempotent shell detach/attach.  It cannot restart the engine, change its
incarnation or Bridge endpoint, mutate operational state, reinject hooks, or stop/resume an agent.  A
real engine crash or controlled engine upgrade is a separate, explicit recovery boundary with its own
identity, audit and compatibility behavior.

## Acceptance criteria

- [x] **Scenario: installing the extension is the complete installation flow**
  - **Given** a supported host with no Tachyon service or prior Tachyon state
  - **When** the user installs the VSIX and first opens/acts on a Tachyon workspace
  - **Then** the extension verifies and materializes its bundled engine and starts the per-workspace service automatically
  - **And** the user does not install a CLI, run a system command, configure a service, or complete a second installer
  - **And** a missing host prerequisite produces one actionable Tachyon error rather than a silent embedded fallback
- [x] **Scenario: Reload Window is operationally idempotent**
  - **Given** a healthy persistent engine, live agents and an attached VS Code shell
  - **When** the window reloads once or repeatedly
  - **Then** engine PID/start identity/incarnation, public Bridge instance/port, agent tmux sessions/PIDs, Delivery leases and scheduler epoch are unchanged
  - **And** the audit contains shell detach/attach only: no engine restart, Bridge generation bump, agent rebind, stop, resume, autostart or hook materialization
  - **And** the new shell receives a coherent snapshot plus subsequent events without duplicating side effects
- [x] **Scenario: the engine works with no editor window**
  - **Given** the last attached VS Code shell closes or crashes
  - **When** agents use Bridge tools or schedules/monitors become due
  - **Then** orchestration, Tasks, handoff, approvals, Delivery, verification and managed-agent lifecycle continue
  - **And** an operation that genuinely requires an editor surface returns bounded `UI_UNAVAILABLE` or a durable UI request; it never hangs or pretends success
- [x] **Scenario: multiple shells attach to one engine**
  - **Given** two windows open the same canonical workspace concurrently
  - **When** both ensure and attach
  - **Then** atomic identity checks elect exactly one engine service and both shells attach to it
  - **And** disconnecting either shell cannot stop the service or invalidate the other shell
  - **And** notification/UI-request claiming is idempotent and cannot execute one engine action twice
- [x] **Scenario: engine state does not depend on ExtensionContext**
  - **Given** an existing installation with operational keys in VS Code global/secret storage
  - **When** the persistent engine is first activated
  - **Then** an allowlisted, versioned, one-time migration transfers the required state to machine-private engine storage atomically
  - **And** subsequent engine starts work without VS Code SecretStorage, globalState, media paths or settings APIs
  - **And** secrets, bearer tokens and descriptors retain their existing local-user security boundary and never enter the workspace or a syncable store
- [x] **Scenario: engine crash and engine upgrade are not shell reloads**
  - **Given** a running engine and compatible persistent state
  - **When** the engine actually crashes or a verified new engine bundle is activated
  - **Then** the supervisor reports a bounded outage, proves the exact old/new incarnation, and performs deterministic recovery or rollback
  - **And** compatible shells negotiate the versioned protocol; incompatible shells fail visibly without constructing an embedded engine
  - **And** any client recovery/rebind is scoped to the real engine-incarnation change, never a VS Code lifecycle event
- [x] **Scenario: shell-only capabilities remain shell-owned**
  - **Given** an attached shell advertises editor capabilities
  - **When** a user asks to open a diff, settings, walkthrough, editor terminal or other VS Code-only surface
  - **Then** a typed, operation-id-bound shell request performs the presentation action
  - **And** the engine itself imports no `vscode`, editor object or render model
- [x] The production extension no longer constructs or disposes `Workspace`; it constructs a versioned
  shell client.  A boundary test fails if `extension.ts` regains engine ownership.
- [x] `deactivate()`, folder removal, panel disposal and client disconnect contain no engine/Bridge stop
  path.  Only explicit Stop/Restart/Upgrade commands or service crash policy alter engine lifecycle.
- [x] The old embedded-engine and persistent-proxy-to-ephemeral-backend production paths are removed
  after cutover; compatibility preserves data/protocols, not two competing lifecycle architectures.

## Non-goals

- Redesigning Delivery, ProcessFence, task semantics, runtime commands, hook content or agent models.
- Remote/cloud/multi-user engine access; the service remains machine-local and workspace-scoped.
- Publishing a standalone npm package or requiring a separately installed Tachyon CLI.
- A generic UI render tree.  Shells consume typed snapshots/events and own their view models.
- Zero-downtime engine upgrades.  A controlled, bounded engine-incarnation transition is acceptable;
  an editor reload causing that transition is not.
- Moving git-visible workspace artifacts out of `.tachyon/` or changing their cleanup policy.

## Platform decision

- The persistent engine ships first on Linux and WSL. macOS is explicitly unsupported until it has a
  zero-step native launcher and process-identity proof; it receives a visible refusal and never falls
  back to the embedded architecture.
- The exact allowlist of VS Code globalState/SecretStorage keys will be frozen from a source inventory
  before migration code is written; unknown keys are not copied wholesale.
