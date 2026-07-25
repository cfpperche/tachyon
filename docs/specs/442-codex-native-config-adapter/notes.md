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

- Existing SDD 428 capability references already persist a human-selected, captured composition for
  Codex skills, MCPs and hooks. Slice C must reuse that authority path instead of adding a second
  selection format. `t-2b258a` joins it with the native scalar materializer, so a canonical launch
  cannot discard capabilities when it also has native policy. Discovery by global/workspace/profile
  source and its Studio editor are separately tracked in `t-c9a086` and `t-115742`.
- The current Codex product documentation describes plugins as a universal plugin directory. That
  does not establish a safe per-agent native-extension projection, so extensions/plugins remain
  outside the generated private home pending the explicit measurement task.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- Slice C contract: hooks, MCPs, skills and native extensions are runtime tooling that a human can
  compose per agent from global, workspace and agent sources. The profile persists enabled/disabled
  selections; the private harness receives only the effective composition; Agent Studio always
  shows the available source inventory and effective result. Tachyon does not add a policy engine
  that judges the human's risk choice. Plugins remain outside this slice.
