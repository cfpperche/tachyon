# 298 — codex-isolated-harness — notes

_Created 2026-06-30._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-06-30: Local Codex CLI is `codex-cli 0.142.4`. `codex --help` states config is loaded from
  `$CODEX_HOME/config.toml`; `~/.codex` contains `auth.json`, `config.toml`, and `sessions/`. Treat
  `CODEX_HOME` as the private config/session root for spec 298.
- 2026-06-30: Initial Claude duet attempts did not return usable guidance:
  `probe-17a736ec-87ee-4a94-b9d2-e17fd4eb0ad9` timed out, `probe-2d06ed52-39da-40a9-8ba9-f3e982a91e92`
  hit budget, and `probe-8055ada1-6f94-4de6-b2c4-b95caef847d6` timed out. Continue with explicit local
  evidence and request a narrower Claude review after implementation.
- 2026-06-30: Post-implementation Claude review attempts also did not return usable guidance:
  `probe-c981e74e-639e-4756-beee-f848c575cd49` timed out, `probe-7dfc9499-78e5-4546-9088-cdb2e6b621e2`
  failed because the requested model was unavailable, and `probe-62331663-10f5-4f9-86c7-2fb0cb7b08eb`
  hit budget. Shipping assessment is therefore based on local tests/typecheck/SDD dogfood, not Claude approval.
- 2026-06-30: Follow-up Claude probe `probe-1dd638bc-b9da-4724-8d9e-abc6d4393468` eventually completed with
  high budget and flagged a real Codex MCP env issue: Codex `env_vars` forwards env keys, so aliases like
  `API_KEY: ${SECRET}` would silently lose the secret. Folded by rejecting Codex harness env aliases; keys must
  match their `${KEY}` references.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- 2026-06-30: Corrected an invalid self-referential `Dogfood:` line. The first attempted dogfood command invoked
  `sdd-dogfood.sh` as its own dogfood target and had to be interrupted before recursion continued. Replaced it with
  the focused Codex harness/resume unit-test slice.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- 2026-06-30: Codex `rules`/`skills`/`hooks` are intentionally rejected in this pass. The early implementation
  would have let those fields flow into Claude-shaped files (`CLAUDE.md`, `skills/`, `settings.json`) under
  `CODEX_HOME`, which would overclaim parity. MCP/config/transcript isolation is shipped now; native Codex
  overlays should be a follow-up spec.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- Unit tests and SDD dogfood prove `auth.json` symlink materialization, but not a real authenticated Codex TUI
  session under redirected `CODEX_HOME`. First manual/plugin dogfood should confirm whether `auth.json` alone is
  sufficient or whether a future pass must seed additional Codex state files.

## Verification log

### 2026-06-30T17:57:30Z — pass (1/1) — source: tasks.md
- `npm test && npx tsc --noEmit` — pass

## Dogfood log

### 2026-06-30T17:58:40Z — pass (1/1) — source: tasks.md — commit: 4d3022c72084b995fc6e4310dab5e5fd3939ce8f
- `npm test -- --run test/unit/harness.test.ts test/unit/agentManager.test.ts test/unit/resume.test.ts` — pass

### 2026-06-30T18:01:41Z — pass (1/1) — source: tasks.md
- `npm test && npx tsc --noEmit` — pass

### 2026-06-30T18:01:50Z — pass (1/1) — source: tasks.md — commit: 4d3022c72084b995fc6e4310dab5e5fd3939ce8f
- `npm test -- --run test/unit/harness.test.ts test/unit/agentManager.test.ts test/unit/resume.test.ts` — pass

### 2026-06-30T18:21:58Z — pass (1/1) — source: tasks.md
- `npm test && npx tsc --noEmit` — pass

### 2026-06-30T18:22:07Z — pass (1/1) — source: tasks.md — commit: 4d3022c72084b995fc6e4310dab5e5fd3939ce8f
- `npm test -- --run test/unit/harness.test.ts test/unit/agentManager.test.ts test/unit/resume.test.ts` — pass
