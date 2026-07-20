# 417 — claude-model-preflight — tasks

_Generated from `plan.md` on 2026-07-19. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add the typed provisional result and narrow Claude adapter.
- [x] Register Claude without changing missing-adapter or Codex policy.
- [x] Add adapter and AgentManager lifecycle regressions.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Claude aliases/full ids reach bounded readiness and can launch as `ready` or `starting`.
- [x] Claude model rejection compensates; unknown-runtime explicit models still fail pre-tmux.
- [x] Focused verification, typecheck and full suite pass.

**Headless check:** `npx vitest run test/unit/runtimeLaunchPreflight.test.ts test/unit/agentManager.test.ts test/unit/bridge.test.ts --maxWorkers=1`

**Verify:** `npx vitest run test/unit/runtimeLaunchPreflight.test.ts test/unit/agentManager.test.ts test/unit/bridge.test.ts --maxWorkers=1`
**Verify:** `npm run typecheck`

## Dogfood

**Dogfood:** `npx vitest run test/unit/agentManager.test.ts -t "delegated Claude explicit model|provisional Claude model rejection" --maxWorkers=1`

## Visual QA

**Visual QA Opt-Out:** no layout or rendered-surface change; this is a headless runtime launch contract.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <417>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook-Opt-Out:** existing `spawn_agent --model` usage becomes reliable; no new operator surface or tool is added.
