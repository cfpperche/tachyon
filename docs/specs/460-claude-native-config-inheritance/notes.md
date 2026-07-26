# 460 — claude-native-config-inheritance — notes

_Created 2026-07-25._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- The Opus 5 review rejected file-granular `settings.json` authoring because the file can transitively
  carry hooks, permissions, environment, plugins, MCP activation and auth behavior. The planned unit
  is a closed key allowlist.
- `settings.local.json` is treated as local runtime state, not reviewed workspace policy; its handling
  must be explicit rather than merged into the canonical projection.

## Deviations

- Planning paused after the adversarial review exposed a broader boundary issue. `t-b516f4` first
  added auditable requested-versus-reported Probe model provenance (`930c2f51`).

## Tradeoffs

- A restrictive allowlist sacrifices transparent inheritance of arbitrary Claude preferences in
  exchange for a stable, reviewable and fail-closed authority boundary.

## Open questions

- Which Claude setting keys are both non-executable and stable enough to support requires local CLI
  measurement before implementation.
