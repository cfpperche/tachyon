# 194 — tachyon-sidebar-taxonomy — tasks

_Generated from `plan.md` on 2026-06-10. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 1. inferKind + KNOWN_AI_CLIS + kind parse/validation + kind-based attention default (loadConfig, schema)
- [x] 2. AgentManager: AgentInfo.kind (declared/ad-hoc/survivor paths)
- [x] 3. Sidebar: Agents/Terminals group nodes + kind base icons, states preserved, empty groups hidden
- [x] 4. F13 integration: newAgent kind quick-pick; addAgent(kind) writes only on divergence
- [x] 5. Tests: inference table, overrides, attention-by-kind (migrated), integration kind assert; fixture prompter pinned kind: agent
- [x] 6. Docs (README taxonomy section, examples) + dogfood + F15 brief recorded in umbrella

## Verification

_Acceptance checks tied to `spec.md` acceptance criteria. Each one should map to a checklist item there._

- [x] All spec 194 acceptance boxes verified (unit + live integration)
- [x] Full suite green: typecheck, build, 115/115 vitest, 14-passing xvfb integration

**Verify:** `bash -c 'cd packages/tachyon && npm run typecheck && npm run build && npm test'`

## Notes

_Anything that came up during execution that doesn't belong in plan.md but is useful for the PR description or future readers._
