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

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- Before Slice B, the human must review the first global/workspace scalar allowlist. Missing keys
  will use Codex defaults; they will not fall through to another source.
