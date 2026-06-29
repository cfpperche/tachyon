# 262 — sidebar-domain-actions — notes

_Created 2026-06-25._

## Design decisions

### 2026-06-25 — parent — Initial scope

The initial draft scopes v1 around sidebar-visible domain mutations, with pins and schedules/proposals as the primary candidates. UI-only operations remain shell-owned.

### 2026-06-25 — claude-exec — Review feedback folded

Claude reviewed the draft as `SHIP-WITH-CHANGES`. The main critique was that sharing the mutation path is insufficient if the refresh/event path remains split; the spec now requires the shared layer to own the mutation + refresh/event contract. Claude recommended excluding command/runbook deletion from v1 and placing the seam under `src/workspace/`, not `src/sidebar/`.

## Deviations

- 2026-06-29 — implementation — Schedule/proposal actions still rely on the existing `Workspace` methods to emit
  `onViewsChanged("schedules")`; `domainActions` accepts the explicit `onChanged` dependency for the shared contract
  but only calls it for pin mutations, where the store itself does not emit the workspace view event.

## Tradeoffs

- 2026-06-29 — implementation — The sidebar now owns the confirmation modal for `schedule:delete` and
  `proposal:reject` before calling `domainActions`, while the VS Code command handlers keep their existing modals.
  This preserves the old destructive-action confirmation behavior without routing the sidebar mutation through the
  command bus.

## Reviews

- 2026-06-29 — Claude review pass 1 — BLOCKING/HIGH: sidebar `schedule:delete` bypassed the previous delete
  confirmation; sidebar `proposal:reject` bypassed the previous reject confirmation. LOW: verify `refresh()` is
  equivalent to `push()` for pin mutations. The two HIGH findings were accepted and folded by adding sidebar-local
  modal confirmations before `domainActions` calls. The LOW was verified: `refresh()` is the public wrapper around
  `push()`.
- 2026-06-29 — Claude review pass 2 — No blocking findings. Claude confirmed destructive sidebar paths now preserve
  modal confirmation and non-destructive paths remain confirmation-free.

## Validation

- 2026-06-29 — `npm test -- --run test/unit/domainActions.test.ts` → 5 passed.
- 2026-06-29 — `npm test -- --run test/unit/sidebarPrototype.test.ts` → 11 passed.
- 2026-06-29 — `npm run typecheck` → clean.
- 2026-06-29 — `npm test` → 138 files passed, 1838 tests passed, 3 skipped.
- 2026-06-29 — `npm run build` → clean.
- 2026-06-29 — `git diff --check` → clean.
- 2026-06-29 — post-close dogfood audit requested by the maintainer:
  `npm test -- --run test/unit/workspaceHeadless.test.ts` → 3 passed. This is the closest existing headless
  Workspace/host smoke; no spec-262-specific headless dogfood script exists. Also attempted `npm run
  test:integration`; the VS Code host smoke ran but failed in pre-existing/unrelated scenarios (`Agent Studio
  pipeline` TypeError in `toEntry`, and `wait_for_agent` timing out as `working`). Multi-root integration then passed
  6/6. Not counted as spec-262 closure evidence.

## Open questions

Resolved on 2026-06-25:

- Use a function module: `src/workspace/domainActions.ts`.
- Domain actions accept an explicit `onChanged(view)` callback; the VS Code shell wires that to its existing refresh behavior.
