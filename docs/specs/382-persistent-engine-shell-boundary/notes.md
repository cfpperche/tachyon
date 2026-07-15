# 382 — persistent-engine-shell-boundary — notes

_Created 2026-07-14._

## Design decisions

- 2026-07-14 — The maintainer ratified the process boundary: the VS Code extension is a shell client;
  the operational engine is persistent and editor-independent.  Reload must be idempotent to the engine.
- 2026-07-14 — Installation UX is invariant: installing the extension is sufficient.  The VSIX bundles,
  verifies, stages and starts the engine automatically; system-service mechanics are not user setup.
- 2026-07-14 — Spec 375 remains historically correct for its reduced proxy scope but does not satisfy the
  original headless-engine intent of task `t-82f4e6`.  Spec 382 owns that residual; it does not rewrite a
  shipped spec.
- 2026-07-14 — Do not block the lifecycle cut on the broad Runtime API research `t-784bc8`.  Build the
  minimum versioned shell contract required for this cut, leaving it as the forcing second consumer for
  later service-layer generalization.

## Deviations

None.

## Tradeoffs

- A controlled real engine upgrade may interrupt the service briefly.  This is accepted to keep one
  authoritative engine process; allowing a VS Code reload to cause that interruption is not accepted.
- The Linux launcher copies only an explicit non-secret environment allowlist into the user service.
  Runtime login files remain available through `HOME`; compatibility for users who rely exclusively on
  provider API keys inherited from the VS Code process must be proven before global cutover.  Arbitrary
  extension-host environment variables are not placed on the `systemd-run` command line.

## Open questions

- Freeze the supported-platform launcher matrix before switching the global default.
- Freeze the legacy globalState/SecretStorage allowlist from source before implementing migration.

## Boundary inventory — 2026-07-14

- The VS Code shell currently has roughly 285 direct `ws.*` access sites.  The largest concrete
  dependencies are `ws.manager` (49), `ws.ledger` (24), `ws.config` (21), `ws.taskStore` (15),
  `ws.pinStore` (13), `ws.bridge` (10) and `ws.pipelines` (7), in addition to 119 identity reads and 66
  workspace-root reads.  This confirms the migration needs an explicit `WorkspaceClient` projection;
  constructing a second read-only `Workspace` in the shell would preserve the wrong ownership boundary.
- `EngineHost` has 61 operational call sites across state, secrets, settings, media, commands and watches.
  The source allowlist/migration inventory remains a separate executable artifact; these aggregate
  counts are orientation, not the frozen contract.

## First implementation slice — 2026-07-14

- Added the versioned engine bundle/protocol primitives under `src/engine-service/`: strict safe relative
  paths, unique hash-pinned file inventory, protocol-range negotiation, stable bundle id and explicit
  service/shell identity shapes.
- Added an automatic per-user bundle store that resolves the platform data directory, rejects dirty or
  hash-drifted sources, atomically stages immutable content-addressed bundles outside the extension
  version directory, re-verifies reuse, and refuses to overwrite a corrupt existing bundle.
- Seven focused tests force manifest traversal/duplicates/missing entrypoint, protocol incompatibility,
  stable ids, zero-config platform roots, source tampering, verified reuse and corrupt-target refusal.

## Second implementation slice — 2026-07-14

- Added a private local engine-control server with versioned `health`, `attach`, `touch`, `snapshot` and
  `detach` envelopes.  Attach proves the canonical workspace and protocol overlap, then returns a
  token-bound ephemeral shell lease without invoking any engine lifecycle operation.
- Duplicate attach for the same shell hello converges on the same session token; distinct windows keep
  independent leases.  Identity/capability drift, wrong workspaces, expired or forged tokens and invalid
  engine snapshots fail closed.
- Snapshot validation happens before a new or existing shell lease is mutated, so a failed resnapshot
  cannot leave a phantom attachment or extend a stale lease.  The private socket has bounded requests,
  idle timeouts, connection cleanup and inode-checked unlink ownership.
- Thirteen focused tests across the first two slices pass together with typecheck, the engine-boundary rule
  and diff-check.  The server is not wired to extension activation or the persistent daemon yet.

## Third implementation slice — 2026-07-14

- Added the shell-side control client with bounded local transport, strict response validation, typed
  unavailable/timeout/protocol/remote errors, token-bound attach/touch/snapshot/detach and monotonic
  snapshot enforcement.  An invalid or expired remote lease clears only shell state.
- Added a real subprocess boundary proof: one independent engine-control process keeps the same PID,
  process-start identity, engine incarnation and Bridge identity while an old shell generation is left
  attached, its replacement attaches, both later detach, and the service continues healthy with zero
  attached shells.
- Eighteen focused tests across the first three slices pass with typecheck, engine-boundary and diff-check.
  The subprocess fixture proves process/lifetime semantics only; it does not yet construct production
  `Workspace` or replace the current proxy daemon.

## Fourth implementation slice — 2026-07-14

- Added `DaemonEngineHost`: the real `Workspace` can now be constructed with no `ExtensionContext` and no
  `vscode` import.  It owns an allowlisted settings projection, private atomic JSON state/secrets,
  bundle-contained media paths, headless `UI_UNAVAILABLE` behavior and plain view/notice events whose
  callbacks remain in the engine across shell reloads.
- Added a Node-only hybrid watcher.  `fs.watch` is only a low-latency hint; bounded polling snapshots are
  authoritative, handle missing directories and nested globstars, do not follow symlinked directories,
  support the VS Code glob subset Tachyon currently uses and fail visibly on traversal, scan overflow or
  unsupported extglob syntax.
- Twenty-eight focused tests across all four slices pass with typecheck, engine-boundary and diff-check.
  This host is not complete until its events/notices are journaled and projected through the control
  protocol; the current production extension still constructs `VsCodeHost`/`Workspace`.

## Fifth implementation slice — 2026-07-14

- Added a private append/compact event journal with monotonic engine-scoped sequence numbers, cloned and
  size-bounded JSON payloads, torn-tail recovery, strict complete-record validation and a bounded retained
  tail.  Old or ahead cursors return `resyncRequired` instead of an ambiguous partial replay.
- Extended the control protocol/server/client with authenticated cursor reads.  Batches are validated for
  engine identity, caller cursor, request limit and exact contiguous sequence; a full snapshot resets the
  shell cursor after compaction.
- Thirty-two focused tests across the five slices pass with typecheck, engine-boundary and diff-check.
  The journal primitives are complete, but the production daemon still needs to feed `DaemonHostEvent`
  records into them and build real Workspace projections.

## Sixth implementation slice — 2026-07-14

- The first real-daemon composition audit exposed a transitive shell dependency missed by the old
  direct-import boundary check: `Workspace` constructed `presentation/Terminals`, which imports `vscode`.
- Terminal presentation is now a host-supplied port.  `VsCodeHost` preserves native terminal tabs and
  manifest restore; `DaemonEngineHost` supplies an explicit headless implementation and the operational
  `Workspace` no longer imports the VS Code presentation module.
- The existing terminal/Workspace/daemon focused suites pass 47/47 with typecheck.  This was a required
  boundary correction before a standalone Node process could honestly construct production Workspace.

## Seventh implementation slice — 2026-07-14

- Added the production `Workspace.createDaemon` path and a complete `startDaemonEngineService`
  composition.  It canonicalizes one workspace, owns daemon state/watchers/scheduler, binds the public
  Bridge directly (no proxy registration), journals host events and exposes authenticated
  health/attach/snapshot/events through the private control socket.
- Snapshot reads are serialized behind a small barrier: host events raised while an asynchronous
  projection is being built are buffered and appended immediately after it, so the snapshot cursor can
  never skip a transition.  Bootstrap lists and strings are explicitly bounded below the 64 KiB control
  response ceiling and report total/truncation instead of silently pretending completeness.
- A real independent Node process now constructs and starts production Workspace with real tmux and a
  real Bridge.  Two shell generations attach to the same process/Bridge identity; a live config edit is
  observed through the Node watcher and event journal; the Bridge remains reachable at zero attached
  shells; graceful shutdown removes both the control socket and tmux control anchor.
- Strengthened `check:engine-boundary` with a runtime import-closure walk from the daemon entrypoint.  It
  currently proves all 150 reachable source files are `vscode`-free, preventing a repeat of the
  transitive `Terminals` leak that the old direct-import grep missed.
- The focused engine/host/Workspace matrix passes 76/76, typecheck and diff-check pass, and the first
  reviewable global gate passes: 343 files, 4,068 tests passed, 3 skipped.

## Eighth implementation slice — 2026-07-14

- Added the Linux/WSL engine supervisor and standalone daemon entrypoint.  The deterministic
  `tachyon-engine-<canonical-root-sha256>.service` transient user unit is the cross-process election:
  one concurrent `systemd-run` wins, contenders wait on the same authenticated control health, and no
  second file-lock authority exists.  The unit restarts real crashes, uses control-group teardown and
  receives only a bounded non-secret environment allowlist.
- Runtime socket/state identities now use 128-bit canonical-root keys rather than the legacy 32-bit
  display hash.  Every engine-created runtime hierarchy level is independently checked as a private,
  real directory; control-path collisions, symlinks and non-socket entries fail closed.  A daemon probes
  an existing socket before stale cleanup and never unlinks a live owner's endpoint.
- The build now emits `dist/engine/engine-daemon.cjs`, its clipboard helper and a hash/provenance-pinned
  manifest.  The daemon's full 154-file runtime import closure remains `vscode`-free and package pruning
  retains the bundle automatically under `dist/`.
- A deterministic unit test forces two starters past the absent-engine probe before either may launch;
  exactly one real Workspace/Bridge process starts, the other contends, both attach to the same identity,
  exact and compatible bundles reuse it, incompatible/corrupt bundles refuse, and a manual duplicate
  cannot steal its live socket.  Five supervisor tests and two packaging tests pass.
- Real-host dogfood used the production `systemd --user` launcher: concurrent outcomes were
  `started + contended`, repeat ensure was `reused-exact`, attach/snapshot/zero-shell health passed, and
  the service unit, daemon PID, control socket and its tmux anchor were gone after graceful stop.
- This checkpoint does **not** wire extension activation yet.  Installing the VSIX is not zero-step until
  the next shell-cutover slice stages this emitted bundle and calls the supervisor automatically.

## Ninth implementation slice — 2026-07-14

- Added the first plain `WorkspaceClient` contract and remote implementation.  The client owns only an
  ephemeral shell id/token, cached snapshot and event cursor; `close()` detaches that lease and contains
  no service-stop path.  It never exposes `Workspace`, manager, store or VS Code objects.
- Sync is serialized and monotonic.  Ordinary events trigger a coherent new snapshot; a compacted/ahead
  cursor forces an explicit full resnapshot.  Lease expiry and bounded transport loss re-run supervisor
  identity proof before attach; a changed process/incarnation/Bridge is reported as `engineChanged`, while
  a same-engine lease renewal is not misclassified as operational recovery.
- Supervisor-health and attach identities must match exactly.  A daemon change in that interval detaches
  the raced lease and retries at most once, preventing an unverified replacement from entering the shell.
  Settings are canonical-digested and cloned at construction so later caller mutation cannot make ensure
  inputs diverge from the hello fingerprint.
- Added the installed-extension staging entrypoint: it reads `dist/engine/engine-manifest.json`, validates
  it, and atomically materializes the immutable bundle outside the disposable extension root.  Production
  remains clean-build-only; the dogfood-only override is explicit.
- Two client tests force incremental sync, retained-tail gap, session expiry, same-endpoint engine
  replacement, caller/listener clone isolation, idempotent detach and the supervisor/attach race.  The
  focused engine/client matrix is 84/84 with typecheck and boundary green.
- Real `systemd --user` dogfood now goes through packaged staging plus **two remote WorkspaceClients**;
  they converge `started + contended`, both snapshot one engine, detach to zero shell leases, reuse the
  exact engine, and leave no unit/process/socket/tmux anchor after stop.
- Remaining before activation cutover: a typed command/invoke protocol and enough projection/action
  adapters for presentation consumers.  `extension.ts` still owns the legacy local Workspace in this
  checkpoint, intentionally avoiding a mixed dual-engine activation.

## Tenth implementation slice — 2026-07-14

- Added a closed, schema-validated `invoke` protocol for the five essential agent lifecycle actions:
  start, graceful stop, kill, restart and resume.  Commands carry a bounded operation id and return an
  exact typed success/error result; successful state is read from the subsequent engine projection
  rather than an unreliable `changed` claim.
- One engine incarnation owns a bounded operation registry.  Concurrent shells using the same operation
  id and canonical intent share one pending/result promise, including cached failures; reuse with a
  different intent fails with `OPERATION_ID_CONFLICT`.  Authentication happens before registry access.
- A proven expired shell lease is a pre-invocation refusal, so the remote client may reattach and submit
  the same operation id.  A timeout, disconnect or invalid response after send is instead reported as
  `OPERATION_OUTCOME_UNKNOWN`: the client reconnects only for future work and never repeats the mutation.
- Operation records are deliberately scoped to the service incarnation.  Exactly-once execution across
  an actual engine crash is not claimed by this slice; a later recovery slice must either durably persist
  the registry or preserve the current fail-ambiguous/no-automatic-replay contract.
- The real process test now starts and kills a real tmux-backed agent through the daemon-owned Workspace,
  verifies both running projections and proves duplicate start executes once.  Focused protocol/client/
  engine tests force concurrent duplicate calls, canonical key order, conflicting intent, cached failure,
  unauthenticated refusal, lease expiry and transport loss after execution begins.
- Real `systemd --user` dogfood invoked remote `agent.start` twice with one operation id, observed the
  running projection, invoked `agent.kill`, observed removal, then proved exact engine reuse and clean
  service/process/socket/tmux teardown.  The focused engine matrix is 88/88 with typecheck, daemon import
  boundary and diff-check green; the earlier reviewable global gate remains the current full-suite proof.
- Remaining before activation cutover: projection/action adapters for presentation consumers and their
  deterministic fake.  `extension.ts` still owns the legacy local Workspace; no mixed production mode is
  enabled by this checkpoint.

## Eleventh implementation slice — 2026-07-14

- Added the first closed Runtime API projection for workspace identity, direct Bridge identity and the
  bounded agent roster.  Every consumed field is exact and bounded; contradictory config state,
  duplicate agents, unknown row fields and a non-loopback/mismatched Bridge URL fail closed.
- `RemoteWorkspaceClient` now validates the presentation projection before accepting an attachment or
  refreshed snapshot and cross-binds workspace root/hash, engine incarnation and Bridge instance/port to
  the supervisor-proven identity.  A malformed daemon snapshot detaches its temporary shell lease rather
  than entering presentation state.
- Added a deterministic, editor-free `FakeWorkspaceClient` for presentation tests.  It clones authority
  boundaries, queues snapshots/events, isolates listener failures, records commands and converges the same
  operation id/intent to one result without pretending unsupported operations succeeded.
- Migrated the Approvals panel off the concrete `Workspace` class onto the narrow
  `WorkspacePresentationTarget`; current production behavior is unchanged because the legacy Workspace
  structurally supplies that read-only identity, while the remote client now has an explicit adapter.
- Froze the remaining shell/presentation debt in `presentation-workspace-inventory.txt`: 25 source files
  still import concrete Workspace after this first migration.  An executable boundary walks every relevant
  source directory, rejects new imports and requires that inventory to shrink explicitly.
- The complete focused engine/projection/client/Approvals matrix passes 98/98 with typecheck,
  daemon import boundary and diff-check green.  No second global full run was made: the first reviewable
  global proof remains current until final closure, per the spec gate policy.
- A fresh packaged `systemd --user` dogfood passed through the strict projection validator, converged
  concurrent starters, remotely started/killed an agent, reused the exact engine and cleaned the unit,
  process, socket and tmux anchor.  This specifically proves the emitted daemon matches the new shell API.
- Remaining before activation cutover: migrate the other 25 consumers, add their missing typed
  projections/actions and only then replace `extension.ts` ownership.  The production extension still
  constructs exactly the legacy Workspace in this checkpoint; no dual engine is activated.

## Twelfth implementation slice — 2026-07-14

- Added a shell-owned `WorkspaceClientRegistry` keyed by canonical workspace root.  Concurrent attaches
  share one connection; an in-flight attach cancelled by folder removal closes only the returned client
  lease and cannot reinsert itself.  Registry shutdown likewise has no engine stop/restart capability.
- The registry remembers the original folder alias, so removal still detaches after the path has already
  disappeared.  Ready clients are sorted by canonical root, and the legacy short workspace hash is
  rejected as ambiguous when it collides instead of silently selecting the wrong workspace.
- Generalized the existing live membership helper with an explicit `detachWorkspace` callback.  The
  current compatibility registry passes legacy `Workspace.dispose()` visibly; the persistent shell
  registry can pass `WorkspaceClient.close()` at cutover without changing membership behavior or gaining
  an engine lifecycle path.
- Migrated Plugins off concrete Workspace onto a shell-owned identity + Git executor contract.  Plugin
  installation remains an editor-side, user-consented filesystem/Git action; the future client adapter
  supplies the same local Git executor without reaching into the daemon.  The executable concrete-import
  inventory therefore shrank from 25 to 24 files.
- Registry/membership/fake/presentation coverage passes 23/23 with typecheck, extension/engine builds,
  daemon import boundary and diff-check green.  Engine code and the strict snapshot format were unchanged,
  so the preceding real systemd dogfood remains the relevant host proof and no extra global full was run.
- The new registry is not yet installed in `extension.ts`; doing so before the remaining presentation
  consumers migrate would create the forbidden mixed mode.  Production continues on the explicit legacy
  callback until the single final activation cutover.

## Thirteenth implementation slice — 2026-07-14

- Added a narrow `WorkspaceStudioTarget` for the five config-backed Studios.  It exposes only workspace
  identity, the currently loaded config and the existing Studio dependency/submit seam; no panel or adapter
  can import, construct, start, stop or dispose the concrete Workspace lifecycle.
- Migrated Agent, Terminal, Command, Runbook and Schedule adapters and panel managers to that structural
  contract.  The legacy Workspace still supplies the exact implementation, so validation, YAML mutation,
  reload, schedule activation and newly-created autostart behavior remain on the existing path unchanged.
- The executable concrete-import inventory shrank from 24 to 14 files.  Its boundary test now names all ten
  migrated Studio surfaces and refuses either a concrete Workspace import or loss of their narrow target.
- The focused Studio/presentation matrix passes 59/59 with typecheck, extension build, daemon import boundary
  and diff-check green.  No second global full was run because this slice changes types only and the first
  reviewable global proof remains current until final closure.
- This is dependency isolation, not the final remote Studio implementation.  A later slice must provide a
  shell-local target backed by daemon projection plus the exact existing persistence semantics before the
  registry can replace the legacy Workspace during activation; production remains single-mode legacy here.

## Fourteenth implementation slice — 2026-07-14

- Added the exact, bounded `studio.submit` wire command for all five config-backed Studios.  The daemon
  executes it through the existing authoritative `Workspace.studioSubmit` path, so validation, atomic YAML
  mutation, reload, scheduler activation and newly-created autostart behavior are not reimplemented in the
  editor shell.
- Operation replay now fingerprints the complete canonical nested command.  Key order cannot split one
  intent, while reusing an operation id with any changed form field fails with `OPERATION_ID_CONFLICT`.
  The real server and deterministic fake share this single identity helper.
- Added `ClientWorkspaceStudioTarget`: form population and best-effort suggestions remain local reads, but
  every mutation crosses the authenticated `WorkspaceClient.invoke` seam with a fresh operation id.  An
  invalid config preserves the last-known-good form state; a genuinely removed config clears it.
- The five adapters retain their synchronous legacy behavior and also accept the remote async result.  The
  focused protocol/control/client/real-daemon/Studio matrix passes 87/87; typecheck, extension build,
  daemon import closure (156 files), engine-boundary and diff-check are green.
- Packaged `systemd --user` dogfood converged two clients on one engine, persisted and replayed one remote
  Studio command, started/killed a real agent through the same engine, reused the exact service after both
  shells detached and left no unit/process/socket/tmux residue.
- The production extension is still not wired to this target and no mixed-mode cutover was enabled.  The
  first reviewable global proof (343 files, 4,068 passed, 3 skipped) remains current; no extra full run was
  justified for this focused vertical slice.

## Fifteenth implementation slice — 2026-07-14

- Moved the always-on Activity writer out of the webview layer and made it operational engine state.  The
  daemon now owns one writer for its Workspace, journals bounded append notifications and awaits any
  in-flight filesystem pass before disposing the Workspace.  The concrete presentation inventory shrank
  from 14 to 13 files.
- Centralized start, restart and resume lifecycle semantics for the legacy shell and daemon.  Both paths
  now preserve the same backoff reset, pre-restart checkpoint, Activity note/arm ordering and failure
  cleanup instead of letting the remote restart silently skip shell-only behavior.
- The real service test exposed an existing control-mode bootstrap race: the channel advertised readiness
  after its attach guard but before the two internal subscription replies left the FIFO.  External work now
  remains on the safe subprocess path until both replies settle; readiness and outage events describe only
  generations that are actually usable.  The start/restart/kill process test passed three consecutive runs
  after removing the diagnostic tmux query that had hidden the race.
- The focused lifecycle/Activity/control/protocol/client/service matrix, including real tmux control,
  passes 87/87 with typecheck, extension+engine build, daemon import closure (164 files) and diff-check
  green.  Packaged systemd dogfood
  converged two clients, executed remote Studio/start/restart/kill, reused the exact engine and cleaned its
  unit, process and listener.  The first reviewable global proof remains current; no extra full run was
  justified before final closure.

## Sixteenth implementation slice — 2026-07-14

- Added an authenticated, strictly validated `probe.view` query seam.  Read-only queries deliberately do
  not enter the mutation operation registry: repeated reads execute again, while authentication, lease
  renewal, caller binding, row/count consistency and the 64 KiB response boundary remain fail-closed.
- `RemoteWorkspaceClient` serializes queries with snapshot/command work and may reconnect and repeat this
  side-effect-free read after a proven session or transport loss.  `FakeWorkspaceClient` records the same
  queries without adding false idempotency behavior, and both paths clone caller-owned inputs/results.
- Migrated the Probe result panel and all presentation item types from concrete `Workspace` to narrow
  identity/query contracts.  Legacy command handlers resolve an item's current workspace by root+hash
  instead of retaining an operational object in the tree item.  The executable concrete-import inventory
  shrank from 13 to 11 files.
- The focused protocol/control/client/Probe/service matrix passes 39/39 with typecheck, extension+engine
  build, daemon import closure (164 files), presentation boundary and diff-check green.  Packaged
  `systemd --user` dogfood queried the real daemon, executed the existing remote Studio/agent lifecycle,
  reused the exact engine and left no unit, process or listener behind.
- No second global full run was made: the first reviewable proof (343 files, 4,068 passed, 3 skipped)
  remains current and this vertical slice has focused wire, process and packaged-host coverage.  Production
  activation remains intentionally legacy until the remaining eleven concrete presentation consumers move.

## Seventeenth implementation slice — 2026-07-14

- Migrated the plugin UI host from concrete `Workspace` to `WorkspacePluginPresentationTarget`.  Installed
  plugin files remain a shell-side filesystem read, while fleet data now arrives through a sparse identity,
  Bridge and agent projection with no manager/store/lifecycle authority exposed to a plugin surface.
- Added a production-ready `WorkspaceClient` adapter and an explicit legacy compatibility adapter used only
  by the not-yet-cut-over activation path.  Both feed one pure fleet builder, preserving stopped/running,
  declared/ad-hoc and needs-input/throttled semantics without duplicating status rules.
- The daemon's bounded agent projection now carries the closed attention-state union.  The shell validator
  rejects unknown values before rendering, and the plugin projection continues to hide agent names behind
  its existing session-scoped handles and labels.  The concrete presentation inventory shrank from 11 to 10.
- Focused plugin/projection/client/service coverage passes 10/10 with typecheck, extension+engine build,
  daemon import closure (164 files), presentation boundary and diff-check green.  Packaged systemd dogfood
  projected one real remotely-started agent through the plugin adapter, then proved exact reuse and clean
  unit/process/listener teardown.
- The first dogfood fixture used `sleep` without `kind: agent`; Tachyon correctly classified it as a terminal
  and the Agents-only plugin projection was empty.  The fixture now declares the intended taxonomy rather
  than weakening production filtering.  No additional global full run was justified before final closure.

## Eighteenth implementation slice — 2026-07-14

- Added a strict daemon-owned Mission Control projection.  It keeps the task body and every board-rendered
  field, removes task refs/deps and validation histories the board does not consume, replaces chip task
  copies with task ids, and validates all identities, enums, counts, references and bounded collection sizes
  before either side accepts the payload.
- Added one dedicated 32 MiB `task.board` response budget while every other control response remains capped
  at 64 KiB.  The bound measures the exact outer transport envelope including its newline; a maximal ordinary
  500-card board fits, while an adversarial attention-heavy board fails before transport.
- Added exact, idempotency-keyed `task.update`, `task.reorder-lane` and `validation.close` commands.  The wire
  surface includes only mutations the board actually emits and delegates execution to the existing Task and
  Validation stores instead of recreating their transition, CAS or persistence rules.
- Migrated `MissionControlPanel` from concrete Workspace/store/manager access to a narrow presentation target,
  with explicit legacy and `WorkspaceClient` adapters.  The liveness timeout/coalescing behavior is preserved,
  truncated remote agent projections fail visibly, and the executable concrete-import inventory shrank from
  10 to 9 files.  Production activation remains intentionally legacy until the single final registry cutover.
- Focused projection/target/protocol/control/client/panel/real-daemon coverage passes 63/63 with typecheck,
  extension+engine build, daemon import closure (169 files) and diff-check green.  The packaged systemd dogfood
  queried and mutated Mission Control, replayed a task update, retained the existing Studio/agent/plugin flow,
  reused the exact engine and cleaned its disposable session; after hardening failure cleanup and explicit
  stopped-state assertions it passed 13 consecutive runs, including 3/3 against the final rebuilt bundle.
- No additional global full run was made: the first reviewable proof (343 files, 4,068 passed, 3 skipped)
  remains the declared intermediate gate, and the next global run is reserved for final closure.

## Nineteenth implementation slice — 2026-07-14

- Added a strict daemon-owned Task Detail projection for the complete read-only panel model: task fields,
  journal, derived/attention state, resolved dependencies, image attachment metadata and prototype metadata.
  Attachment and prototype bytes never cross the control socket; the shell maps verified workspace-local
  files through traversal-safe stores and revalidates prototype integrity/policy before assembling `srcdoc`.
- Added exact `task.detail` and idempotency-keyed `task.prototype.review` protocol operations.  Task Detail
  has a dedicated 2 MiB response budget measured over the exact newline-terminated outer envelope, while
  ordinary control responses remain at 64 KiB.  Legacy and remote adapters validate the same narrow update
  and review shapes and share one prototype-review/reconciliation service.
- Migrated `TaskDetailPanel` from concrete Workspace/Task/attachment/prototype store access to
  `WorkspaceTaskDetailTarget`.  Async generations prevent an older remote response from overwriting a newer
  refresh, and the concrete presentation inventory shrank from 9 to 8 files.  Task Studio remains a separate
  later slice because its provisional 10 MiB attachments require an explicit media transport contract.
- Prototype review now emits an authoritative `views-changed(tasks)` event from the daemon.  This is required
  for note/rejection mutations that touch only `attachments/<task>/prototypes.json`; a real-process test proves
  another shell observes the event without relying on the top-level task-file watcher.
- The final related matrix passes 159/159 with typecheck, extension+engine build, 172-file editor-free daemon
  import closure, presentation boundary and diff-check green.  Packaged `systemd --user` dogfood queried Task
  Detail, hydrated verified image/prototype media, reconciled a prototype decision, exercised the narrow task
  update, retained the existing Mission Control/Studio/agent/plugin lifecycle and passed 3/3 against the final
  rebuilt bundle.  Its first run correctly rejected a fixture that moved a P1 task through the no-priority
  reorder lane; the fixture now exercises the actual P1 lane rather than weakening production validation.
- No additional global full run was made: the first reviewable proof (343 files, 4,068 passed, 3 skipped)
  remains the declared intermediate gate, and the next global run is reserved for final closure.

## Twentieth implementation slice — 2026-07-14

- Added a strict daemon-owned Task Studio projection and exact `task.studio`/`task.studio.apply`/
  `task.studio.cancel` protocol.  Existing task anchoring, dirty-field CAS, staged create, attachment GC and
  prototype persistence now live in one shared application service used by both the legacy and daemon
  targets; the editor panel no longer imports a concrete Workspace or any Task store.
- Large authoring payloads use one private staged-file channel under the existing engine runtime directory,
  not another socket or daemon.  Commands carry only a random token, exact byte size and SHA-256.  The daemon
  opens with `O_NOFOLLOW`, verifies type/owner/mode/link count/size/hash against the open descriptor, consumes
  once and removes by inode identity.  Shell success and failure paths both discard leftovers, and startup
  removes only stale regular files from the private namespace.
- Operation replay remains exact after consumption: the control server resolves the operation id and complete
  command fingerprint before invoking the Task Studio handler.  The real-process test saves through a staged
  payload, proves the file is gone, then replays the same operation successfully without rereading it.  A new
  protocol test also exposed and fixed a validator bug that had required physically-present optional result
  fields even for a valid `saved` outcome.
- Task Studio images, sketches and prototypes are hydrated from traversal-safe workspace-local stores rather
  than copied back through the control response.  The panel preserves native file pickers and soft-limit UX;
  cancellation remains best-effort so an unavailable daemon cannot trap the user in the editor.  The concrete
  presentation inventory shrank from eight files to six.
- The final focused protocol/control/staging/target/adapter/panel/boundary/real-service matrix passes 79/79;
  typecheck, extension+engine build, the 180-file editor-free daemon import closure and diff-check are green.
  Packaged `systemd --user` dogfood converged two clients, remotely loaded/saved Task Studio, staged image and
  prototype media, reused the exact engine, exercised the existing agent lifecycle and cleaned its disposable
  unit/process/socket/tmux state.
- No additional global full run was made: the first reviewable proof (343 files, 4,068 passed, 3 skipped)
  remains the declared intermediate gate, and the next global run is reserved for final closure.  Production
  activation is still intentionally legacy until every remaining presentation consumer is migrated and the
  registry can replace it in one atomic cutover.
