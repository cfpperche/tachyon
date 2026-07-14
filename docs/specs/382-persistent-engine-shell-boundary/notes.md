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
