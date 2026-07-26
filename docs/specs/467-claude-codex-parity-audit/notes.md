# 467 — claude-codex-parity-audit — notes

_Created 2026-07-26._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## 2026-07-26 — comparative evidence

- Focused suite: 6 files, 545 tests passed.
- Headless Dev Host scenario
  `scripts/dev-host/scenarios/claude-codex-parity-audit.mjs`: 10/10 assertions
  passed after creating and reopening both canonical profiles.
- Visual inspection: Claude reported `Ready`; Codex reported `Limited` with the
  exact native-fork limitation. Runtime fields and native-policy provenance
  were legible and internally consistent.
- The first two scenario iterations exposed driver selection/readiness
  assumptions, not product bugs: the driver initially reused the first webview,
  and then incorrectly required Codex to report `Ready`. The final oracle closes
  the first Studio and explicitly requires Codex's honest `Limited` state.

## Dogfood log

### 2026-07-26T14:26:30Z — pass (1/1) — source: tasks.md — commit: b4fa0f7b6f4e9211fa6da735e4c96f87c57446e1
- `npx vitest run test/unit/agentProfileStudio.test.ts test/unit/agentProfileConfigLoader.test.ts test/unit/codexRuntimeConfigInventory.test.ts test/unit/claudeRuntimeConfigInventory.test.ts test/unit/harness.test.ts test/unit/agentManager.test.ts` — pass

## Verification log

### 2026-07-26T14:27:21Z — fail (1/2) — source: tasks.md
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — fail

### 2026-07-26T14:30:32Z — pass (2/2) — source: tasks.md
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — pass
