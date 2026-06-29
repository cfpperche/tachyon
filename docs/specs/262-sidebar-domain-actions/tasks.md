# 262 — sidebar-domain-actions — tasks

_Generated from `plan.md` on 2026-06-25. Work top-to-bottom. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 1. Resolve open questions after Claude/Codex review.
- [x] 2. Lock the shared action-layer location, public function shape, and refresh/event contract.
- [x] 3. Create `src/workspace/domainActions.ts` with v1 actions: pin toggle/delete, schedule pause/delete, proposal approve/reject.
- [x] 4. Make domain actions accept an `onChanged(view)` dependency and avoid any `vscode` import.
- [x] 5. Rewire `SidebarPrototypeProvider` in-scope mutation routes to `domainActions` without routing through VS Code commands.
- [x] 6. Rewire matching VS Code command handlers to call `domainActions` after shell-owned confirmation/input.
- [x] 7. Keep shell-only routes (`pin:copy`, `pin:preview`, `pin:edit`, `command:open`, studios, terminals) outside `domainActions`.
- [x] 8. Add focused unit coverage for domain actions, sidebar routing, stale hash no-op behavior, and sibling preservation.

## Verification

- [x] `npm run typecheck`
- [x] `npm test -- --run test/unit/sidebarPrototype.test.ts`
- [x] `npm test -- --run test/unit/domainActions.test.ts`
- [x] Relevant command/action unit tests added by the plan, including command-handler reuse if a focused harness exists.
- [x] `npm test`
- [x] `npm run build`
- [x] `git diff --check`

## Closure evidence

- `npm test -- --run test/unit/domainActions.test.ts` — 5 passed.
- `npm test -- --run test/unit/sidebarPrototype.test.ts` — 11 passed.
- `npm run typecheck` — clean.
- `npm test` — 138 files passed, 1838 tests passed, 3 skipped.
- `npm run build` — clean.
- `git diff --check` — clean.
- Claude review pass 1 found two HIGH regressions; both folded. Claude review pass 2: "No blocking findings."

## Notes

- Visual UI changes are intentionally excluded.
- Command/runbook deletion is intentionally deferred because confirmation-bearing config edits deserve a separate pass.
