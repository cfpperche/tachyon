# 418 — sidebar-agent-filter-dropdown — tasks

_Generated from `plan.md` on 2026-07-19. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Move all status-filter options and counts into a native select in the Agents header action cluster.
- [x] Replace pill styles with compact responsive dropdown styles and remove dead pill selectors.
- [x] Update regression coverage and dogfood documentation.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] All six options, counts, zero-disabled semantics, filtering, and empty behavior remain covered.
- [x] Header source/CSS contract proves no second filter row or pill-only selectors remain.
- [x] Visual QA passes headlessly at 360×760 and 240×760.
- [x] Focused tests, build, typecheck, and full suite pass.

**Headless check:** `npx vitest run test/unit/agentStatusFilter.test.ts test/unit/agentStatusFilterDropdown.test.ts test/unit/webviewPreviewRoutes.test.ts --maxWorkers=1`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

**Verify:** `npx vitest run test/unit/agentStatusFilter.test.ts test/unit/agentStatusFilterDropdown.test.ts test/unit/webviewPreviewRoutes.test.ts --maxWorkers=1`
**Verify:** `npm run typecheck`
**Verify:** `npm run build`

## Dogfood

**Dogfood:** `npx vitest run test/unit/agentStatusFilterDropdown.test.ts -t "Agents header dropdown" --maxWorkers=1`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** optional after release; open Agents and switch every dropdown option, confirming counts and rows.

## Visual QA

- [x] Evidence: `docs/specs/418-sidebar-agent-filter-dropdown/evidence/sidebar-default-360x760.png`, `docs/specs/418-sidebar-agent-filter-dropdown/evidence/sidebar-default-240x760.png`
- [x] Verdict: pass — all header controls fit one row at both widths; the former pill lane is absent and selected label/count remain legible.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <418>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook-Opt-Out:** existing filtering interaction is compacted but no new operator workflow is introduced.
