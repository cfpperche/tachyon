# 382 — persistent-engine-shell-boundary — tasks

_Generated from `plan.md` on 2026-07-14. Work top-to-bottom. No automatic integration._

## Contract and inventory

- [x] Freeze the complete production inventory of shell code that constructs, disposes or directly reads
  concrete `Workspace`/manager/store objects; add a boundary test for the final forbidden set.
- [ ] Freeze the allowlist of EngineHost state/settings/secrets/media/watch capabilities that the daemon
  must own or import; record migration source, destination and rollback for each key.
- [ ] Add executable schemas and compatibility rules for bundle manifest, service descriptor, shell
  hello/session, snapshot, event, command and typed error envelopes.

## Persistent engine

- [x] Implement content-addressed bundled-engine staging with atomic hash/provenance verification and a
  last-known-compatible rollback bundle; no runtime path points into the extension version directory.
- [x] Implement `DaemonEngineHost` with atomic state/private-secret stores, daemon media resolution,
  locale substitution, durable notices/events and a Node watcher plus bounded polling fallback.
- [x] Evolve the persistent service entrypoint to construct/start exactly one `Workspace`, own the public
  Bridge listener directly and expose health/attach/snapshot/events/invoke/explicit-stop control methods.
- [x] Make concurrent starters and duplicate attach/invoke operations converge by exact workspace,
  service-incarnation and operation identity.

## Shell cutover

- [x] Introduce `WorkspaceClient` and a remote implementation with full snapshot, monotonic event cursor,
  reconnect/resync and typed command results; add a deterministic fake for presentation tests.
- [x] Migrate sidebar, Activity/Mission Control/Studios, commands, notifications and terminal presentation
  from concrete `Workspace` access to `WorkspaceClient` projections/actions.
- [ ] Route editor-only capabilities through bounded shell requests; return `UI_UNAVAILABLE` when no
  capable shell is attached and prevent duplicate claims across windows.
- [x] Change extension activation to ensure/stage/attach only; change deactivate/folder removal to detach
  only; remove all production `Workspace.create`, `Workspace.start`, `Workspace.dispose` and backend
  registration calls from the shell.
- [x] Remove embedded-engine fallback, proxy-to-ephemeral-backend mode and shell-generation Bridge-client
  rebind.  Retain recovery only for a proven engine incarnation change.

## Upgrade, recovery and compatibility

- [ ] Implement one-time allowlisted migration from VS Code global/secret state with atomic completion
  marker, idempotent replay and rollback proof.
- [ ] Implement compatible attach, verified bundle upgrade, incompatible refusal, crash restart and
  last-known-compatible rollback with exact incarnation audit.
- [ ] Implement zero-step launcher adapters for every declared supported platform or keep that platform
  explicitly unsupported without falling back to the embedded architecture.

## Verification

- [ ] Focused protocol/state/service/shell tests force concurrent ensure, duplicate invoke, event gaps,
  state migration, missing UI, crash, incompatible version and rollback.
- [ ] A real process test proves repeated shell detach/attach keeps engine/Bridge/agent/Delivery/scheduler
  identities unchanged and emits no lifecycle side effects.
- [ ] A no-shell interval proves Bridge tools and one scheduled/monitor action remain functional.
- [ ] Packaging/provenance tests prove the VSIX contains the engine and first use requires no manual step.
- [ ] `npm run typecheck`, engine-boundary/diff checks and `npm run verify:full:quiet` pass.

**Verify:** `npm run typecheck && npm run check:engine-boundary && npm run verify:full:quiet`

## Dogfood

**Dogfood:** `node scripts/dogfood/persistent-engine.mjs`

**Human dogfood:** Install the candidate VSIX normally; open a Tachyon workspace without running any
setup command; record engine identity, Bridge identity, live agent PIDs and Delivery/scheduler state;
Reload Window twice and close/reopen the window; prove those identities and operations did not change,
the UI resnapshotted, and an agent used Tasks/handoff while no window was attached.  The agent will not
manipulate the VS Code window.

## Visual QA

- [ ] Evidence: installed before/during/after-reload screenshots of connection state and restored views.
- [ ] Verdict: no duplicate rows/actions, stale state, connection flicker or manual-setup prompt.
