# 370 — runtime-launch-preflight — notes

_Created 2026-07-10._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-10 incident: coordinator requested `codex --model gpt-5.6`; Bridge returned spawn success and task
  `t-79dee5` was assigned, but Codex immediately emitted `invalid_request_error` because that model is not supported
  with the effective ChatGPT account. The agent was killed and the task returned to triaged.
- Live `codex-cli 0.144.1` evidence: `codex debug models` lists `gpt-5.6-sol`, `gpt-5.6-terra`, and
  `gpt-5.6-luna`; generic `gpt-5.6` is absent. The catalog is dynamic runtime evidence, not product data.
- Root cause: `spawn_agent` validates contract/isolation/limits, while `AgentManager.spawnCore` treats successful tmux
  creation as successful launch. `RuntimeProfile.model` explicitly contains labels/aliases only.
- Prior decision preserved: spec 328 correctly rejected Tachyon-owned dated model catalogs. This design adds a
  runtime-native dynamic preflight instead.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

- Ratify the three policy questions in `spec.md` before delegation or implementation.
