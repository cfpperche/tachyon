# 417 — claude-model-preflight — notes

_Created 2026-07-19._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-19 — Claude Code 2.1.215 documents aliases/full model ids but exposes no bounded account-aware catalog command. A Tachyon-owned allowlist would prove syntax at best and drift at worst, so explicit selections are represented as `provisional` and validated by the actual runtime startup.
- 2026-07-19 — The policy remains capability-scoped: registering a Claude startup-validation adapter does not relax the registry's missing-adapter `unverifiable` result. Grok continues to fail closed.

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Dogfood log

### 2026-07-20T01:10:22Z — pass (1/1) — source: tasks.md — commit: 0c147cb22578b0b43b359d6b12fabfa1aaf3d368
- `npx vitest run test/unit/agentManager.test.ts -t "delegated Claude explicit model|provisional Claude model rejection" --maxWorkers=1` — pass

## Verification log

### 2026-07-20T01:10:23Z — pass (2/2) — source: tasks.md
- `npx vitest run test/unit/runtimeLaunchPreflight.test.ts test/unit/agentManager.test.ts test/unit/bridge.test.ts --maxWorkers=1` — pass
- `npm run typecheck` — pass
