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
