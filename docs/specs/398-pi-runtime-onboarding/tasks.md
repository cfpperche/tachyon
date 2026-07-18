# 398 — pi-runtime-onboarding — tasks

_Generated from `plan.md` on 2026-07-18. Work top-to-bottom._

## Implementation

- [x] Add and test Pi's positional opening-prompt adapter.
- [x] Implement the testable MCP catalog/result/schema mapping used by the Pi extension.
- [x] Implement the Pi extension lifecycle, native tool registration, status command and safe disconnect behavior.
- [x] Bundle the extension as an immutable persistent-engine asset and authenticate it in the engine manifest.
- [x] Plumb the staged extension path through engine → Workspace → AgentManager.
- [x] Inject `--extension` additively for Pi across spawn/restart, with no token in argv/files and honest `wired` state.
- [x] Add focused regression and packaging-boundary tests.
- [x] Add real-Pi headless dogfood and record results.
- [x] Update spec/notes with deviations and evidence; leave the branch in-progress and unmerged pending human dogfood.

## Verification

- [x] Pi receives primer/opening brief and additive extension injection.
- [x] Native Pi tools proxy authenticated MCP calls and preserve success/error/cancellation.
- [x] Missing extension and Bridge failures are visible without false wiring claims.
- [x] Engine staging contains the hash-authenticated extension asset.
- [x] Existing runtime command composition remains green in focused AgentManager coverage.
- [x] `PI-001` remains green with its fixed oracle unchanged.

**Verify:** `npm run typecheck`
**Verify:** `npx vitest run test/unit/piRuntimeOnboarding.test.ts test/unit/agentManager.test.ts test/unit/piBridgeExtension.test.ts test/unit/engineBundleStore.test.ts`
**Verify:** `npm run test:invariants`

## Dogfood

**Dogfood:** `node scripts/dogfood/pi-runtime-onboarding.mjs`

**Human dogfood:** After installing/reloading the branch build, restart the declared `pi` agent, confirm the Tachyon primer appears, run `/tachyon-bridge-status`, and ask Pi to call `list_agents` and identify itself as `pi`.

## Visual QA

**Visual QA Opt-Out:** only terminal text/status emitted by the Pi extension changes; headless RPC dogfood exercises that rendering-independent contract.

## Cookbook

**Cookbook-Opt-Out:** onboarding is automatic for every Tachyon-spawned Pi process; operator usage remains the existing agent start/restart flow documented by the product README.
