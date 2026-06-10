# 197 — tachyon-agent-lineage — tasks

_Generated from `plan.md` on 2026-06-10. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 1. AgentManager: SpawnOptions refactor + lineage map + AgentInfo.parent + clear-on-kill
- [x] 2. spawn_agent: instructions + parent params (description mandates parent)
- [x] 3. Sidebar: 3-level tree (group → roots → children), "spawned by X", orphan promotion
- [x] 4. _spawn internal seam + l10n key (pt-BR)
- [x] 5. Tests: unit (lineage lifecycle, instructions composeCommand on ad-hoc, MCP parent round-trip) + live integration (_spawn → _agents) 
- [x] 6. Live E2E (real claude as orchestrator: spawn with parent → list → kill) + README + dogfood

## Verification

_Acceptance checks tied to `spec.md` acceptance criteria. Each one should map to a checklist item there._

- [x] All spec 197 acceptance boxes verified (unit + integration + live E2E)
- [x] Full suite green: typecheck, build, 135/135 vitest, 17-passing xvfb integration

**Verify:** `bash -c 'cd packages/tachyon && npm run typecheck && npm run build && npm test'`

## Notes

_Anything that came up during execution that doesn't belong in plan.md but is useful for the PR description or future readers._
