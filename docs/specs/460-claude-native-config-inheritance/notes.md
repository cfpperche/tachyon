# 460 — claude-native-config-inheritance — notes

_Created 2026-07-25._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- The Opus 5 review rejected file-granular `settings.json` authoring because the file can transitively
  carry hooks, permissions, environment, plugins, MCP activation and auth behavior. The planned unit
  is a closed key allowlist.
- `settings.local.json` is treated as local runtime state, not reviewed workspace policy; its handling
  must be explicit rather than merged into the canonical projection.
- The measured scalar allowlist is `permissions` (`allow`, `ask`, `deny`, `defaultMode`,
  `additionalDirectories`), interface (`theme`, `prefersReducedMotion`, `spinnerTipsEnabled`,
  `showTurnDuration`, `terminalProgressBarEnabled`) and `alwaysThinkingEnabled`. `statusLine`, hooks,
  environment and plugin keys are deliberately excluded because they execute or expand authority.
- Tooling is not silently grandfathered. Claude has no admitted profile-capability projector, so
  workspace skills/hooks/MCP remain excluded; strict MCP contains only the host-custodied Bridge.

## Deviations

- Planning paused after the adversarial review exposed a broader boundary issue. `t-b516f4` first
  added auditable requested-versus-reported Probe model provenance (`930c2f51`).
- A final probe requested as `claude-opus-5` was discarded: run
  `probe-9477100b-4696-4f85-b5fb-d40e2256cd7d` timed out and reported
  `claude-haiku-4-5` in `modelUsage`, so it is not an Opus 5 verdict.

## Tradeoffs

- A restrictive allowlist sacrifices transparent inheritance of arbitrary Claude preferences in
  exchange for a stable, reviewable and fail-closed authority boundary.

## Open questions

- Explicit Claude skill/hook/MCP capability projection remains future parity work; this slice removes
  implicit inheritance instead of widening authority without a grant model.

## Sources

- Claude Code settings scopes and precedence: https://code.claude.com/docs/en/settings
- Claude Code permission settings: https://code.claude.com/docs/en/permissions
- `statusLine` executable-command semantics: https://code.claude.com/docs/en/statusline
