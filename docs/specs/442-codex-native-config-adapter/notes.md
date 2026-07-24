# 442 — codex-native-config-adapter — notes

_Created 2026-07-23._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Slice A accepts exactly `selectors / agent / overlay / every-launch / fresh+restart+resume`.
  Lifecycle order is not semantic, but adding `fork` rejects the tuple.
- The resolved launch definition carries typed selector values, never raw TOML. The Codex materializer
  renders only `model`, `model_provider`, `model_reasoning_effort` and `service_tier`.
- Every materialization atomically replaces the private `config.toml`; authentication remains an
  external symlink created by the existing private-home boundary.
- The human ratified Slice B's closed allowlist: `approval_policy`, `sandbox_mode`, `personality`,
  `tui.status_line`, `tui.status_line_use_colors` and `features.terminal_resize_reflow`.
  Memory, auth/provider redirects, hooks/trust, telemetry/notify, notices and all other flags remain
  excluded.
- Global config is parsed and filtered because the private `CODEX_HOME` suppresses the ambient
  global file. Workspace config remains visible to Codex itself, so selecting a workspace family
  fails closed if `.codex/config.toml` contains any leaf outside the explicitly selected family
  allowlists.
- Missing selected keys stay absent in the generated file and therefore use Codex defaults; there
  is no cross-source fallback.
- TOML parsing uses `@iarna/toml`; `smol-toml` was rejected because its ESM-only package shape is
  incompatible with Tachyon's current CommonJS extension build.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- Slice C still needs a separate trust and materialization review for tooling-shaped configuration.
