# 262 — sidebar-domain-actions — tasks

_Generated from `plan.md` on 2026-06-25. Work top-to-bottom. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 1. Resolve open questions after Claude/Codex review.
- [x] 2. Lock the shared action-layer location, public function shape, and refresh/event contract.
- [ ] 3. Create `src/workspace/domainActions.ts` with v1 actions: pin toggle/delete, schedule pause/delete, proposal approve/reject.
- [ ] 4. Make domain actions accept an `onChanged(view)` dependency and avoid any `vscode` import.
- [ ] 5. Rewire `SidebarPrototypeProvider` in-scope mutation routes to `domainActions` without routing through VS Code commands.
- [ ] 6. Rewire matching VS Code command handlers to call `domainActions` after shell-owned confirmation/input.
- [ ] 7. Keep shell-only routes (`pin:copy`, `pin:preview`, `pin:edit`, `command:open`, studios, terminals) outside `domainActions`.
- [ ] 8. Add focused unit coverage for domain actions, sidebar routing, stale hash no-op behavior, and sibling preservation.

## Verification

- [ ] `npm run typecheck`
- [ ] `npm test -- --run test/unit/sidebarPrototype.test.ts`
- [ ] `npm test -- --run test/unit/domainActions.test.ts`
- [ ] Relevant command/action unit tests added by the plan, including command-handler reuse if a focused harness exists.
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `git diff --check`

## Notes

- Visual UI changes are intentionally excluded.
- Command/runbook deletion is intentionally deferred because confirmation-bearing config edits deserve a separate pass.
