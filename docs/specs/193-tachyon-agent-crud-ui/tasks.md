# 193 — tachyon-agent-crud-ui — tasks

_Generated from `plan.md` on 2026-06-10. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 1. YamlConfigEditor (add/clone/delete/rename/entryLine; comment preservation; layout cleanup; last-agent guard) + 8 unit tests
- [x] 2. extension: mutateConfig helper + newAgent/clone/rename/delete/edit commands (args for automation; guardrails)
- [x] 3. package.json commands + 2_manage context menus (viewItem regex)
- [x] 4. Live host integration: full CRUD via real commands, yml asserted, fixture restored
- [x] 5. README + dogfood

## Verification

_Acceptance checks tied to `spec.md` acceptance criteria. Each one should map to a checklist item there._

- [x] All spec 193 acceptance boxes verified (unit + live integration)
- [x] Full suite green: typecheck, build, 114/114 vitest, 14-passing xvfb integration

**Verify:** `bash -c 'cd packages/tachyon && npm run typecheck && npm run build && npm test'`

## Notes

_Anything that came up during execution that doesn't belong in plan.md but is useful for the PR description or future readers._
