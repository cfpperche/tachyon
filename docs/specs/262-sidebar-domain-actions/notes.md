# 262 — sidebar-domain-actions — notes

_Created 2026-06-25._

## Design decisions

### 2026-06-25 — parent — Initial scope

The initial draft scopes v1 around sidebar-visible domain mutations, with pins and schedules/proposals as the primary candidates. UI-only operations remain shell-owned.

### 2026-06-25 — claude-exec — Review feedback folded

Claude reviewed the draft as `SHIP-WITH-CHANGES`. The main critique was that sharing the mutation path is insufficient if the refresh/event path remains split; the spec now requires the shared layer to own the mutation + refresh/event contract. Claude recommended excluding command/runbook deletion from v1 and placing the seam under `src/workspace/`, not `src/sidebar/`.

## Deviations

## Tradeoffs

## Open questions

Resolved on 2026-06-25:

- Use a function module: `src/workspace/domainActions.ts`.
- Domain actions accept an explicit `onChanged(view)` callback; the VS Code shell wires that to its existing refresh behavior.
