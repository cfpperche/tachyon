# 382 — persistent-engine-shell-boundary — tasks

_Generated from `plan.md` on 2026-07-14. Work top-to-bottom. No automatic integration._

## Contract and inventory

- [x] Freeze the complete production inventory of shell code that constructs, disposes or directly reads
  concrete `Workspace`/manager/store objects; add a boundary test for the final forbidden set.
- [x] Freeze the allowlist of EngineHost state/settings/secrets/media/watch capabilities that the daemon
  must own or import; record migration source, destination and rollback for each key.
- [x] Add executable schemas and compatibility rules for bundle manifest, service descriptor, shell
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
- [x] Route editor-only capabilities through bounded shell requests; return `UI_UNAVAILABLE` when no
  capable shell is attached and prevent duplicate claims across windows.
- [x] Change extension activation to ensure/stage/attach only; change deactivate/folder removal to detach
  only; remove all production `Workspace.create`, `Workspace.start`, `Workspace.dispose` and backend
  registration calls from the shell.
- [x] Remove embedded-engine fallback, proxy-to-ephemeral-backend mode and shell-generation Bridge-client
  rebind.  Retain recovery only for a proven engine incarnation change.

## Upgrade, recovery and compatibility

- [x] Implement one-time allowlisted migration from VS Code global/secret state with atomic completion
  marker, idempotent replay and rollback proof.
- [x] Implement compatible attach, verified bundle upgrade, incompatible refusal, crash restart and
  last-known-compatible rollback with exact incarnation audit.
- [x] Implement zero-step launcher adapters for every declared supported platform or keep that platform
  explicitly unsupported without falling back to the embedded architecture.

## Verification

- [x] Focused protocol/state/service/shell tests force concurrent ensure, duplicate invoke, event gaps,
  state migration, missing UI, crash, incompatible version and rollback.
- [x] A real process test proves repeated shell detach/attach keeps engine/Bridge/agent/Delivery/scheduler
  identities unchanged and emits no lifecycle side effects.
- [x] A no-shell interval proves Bridge tools and one scheduled/monitor action remain functional.
- [x] Packaging/provenance tests prove the VSIX contains the engine and first use requires no manual step.
- [x] `npm run typecheck`, engine-boundary/diff checks and `npm run verify:full:quiet` pass.

**Verify:** `npm run typecheck && npm run check:engine-boundary && npm run verify:full:quiet`

## Dogfood

**Dogfood:** `node scripts/dogfood/persistent-engine.mjs`

**Human dogfood:** Install the candidate VSIX normally; open a Tachyon workspace without running any
setup command; record engine identity, Bridge identity, live agent PIDs and Delivery/scheduler state;
Reload Window twice and close/reopen the window; prove those identities and operations did not change,
the UI resnapshotted, and an agent used Tasks/handoff while no window was attached.  The agent will not
manipulate the VS Code window.

## Visual QA

- [x] Evidence: `.tachyon/evidence/t-82f4e6-installed-dogfood/04-clean-boot-before-reload.png`
  and `.tachyon/evidence/t-82f4e6-installed-dogfood/05-after-idempotent-reload.png`.
- [x] Verdict: the installed sidebar and shell views restored with one live Codex row, the Bridge connected,
  no duplicate action/row and no manual-setup prompt; engine identity remained unchanged underneath the UI.

## Installed-acceptance blocker closure — 2026-07-15

- [x] Declare Linux/WSL as the only supported persistent-engine targets; macOS now refuses visibly and
  cannot fall back to the embedded lifecycle.
- [x] Stage and re-verify the exact engine runtime in immutable Tachyon-owned storage; every initial,
  upgrade and rollback `ExecStart` uses that staged runtime rather than a disposable VS Code path.
- [x] Persist daemon-owned terminal intents and route exact present/close requests through the claimed
  shell UI channel, including manual open/close and ordered replacement across shell reloads.
- [x] Retain notifications through no-shell/disconnect intervals, present them sequentially and execute
  an id-bound action at most once without rendering the journal event a second time.
- [x] Move global tmux watchdog, identity-bound recovery and Inspector kill mutations into the engine;
  the shell retains only read-only prerequisite probes and terminal redraw presentation.
- [x] Advance extension version and shell protocol together so an installed 0.56.7/protocol-2 engine is
  upgraded once rather than silently reusing the pre-fix daemon.
- [x] Focused tests, typecheck, production build, engine boundary, diff-check, packaged dogfood and final
  `npm run verify:full:quiet` closure gate pass on the complete candidate.

## Installed notification-starvation follow-up — 2026-07-15

- [x] Prove a visible `notice.present` whose native VS Code promise remains unresolved cannot block shell
      synchronization or a read-only sidebar query.
- [x] Complete claimed notification UI work outside the shell client's serialized operational tail while
      preserving the broker's single claimant, exact operation id and at-most-once engine action.
- [x] Prove notification completion still reaches the engine, run the focused shell suite, typecheck and
      repository-wide `npm test` on the final source candidate.
- [x] Package the clean `0.56.10` candidate and complete maintainer-driven installed reload validation.
