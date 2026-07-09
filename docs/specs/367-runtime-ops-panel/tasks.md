# 367 - Runtime Ops panel - tasks

_Generated from `plan.md` on 2026-07-09. Work top-to-bottom. If a task reveals the plan is wrong, update
`plan.md` before continuing._

## Implementation

### Phase 1 - panel shell and entry point

- [ ] Add the `tachyonRuntimeOps` panel container, `tachyonRuntimeOpsView`, localized labels, and refresh view action.
- [ ] Implement/register `RuntimeOpsViewProvider` with the shared CSP shell and an empty typed snapshot.
- [ ] Change `tachyon.showRuntimeUsage` and the `$(pulse) Runtime` status item to reveal/focus the contributed panel;
  prove the generated command id in a real Extension Development Host.
- [ ] Add provider lifecycle tests for resolve, hidden/reveal, ready, refresh, dispose, and no-workspace states.

### Phase 2 - honest usage projection

- [ ] Define `RuntimeOpsSnapshotV1`, source metadata, unavailable reasons, and runtime/workspace/agent keys.
- [ ] Extract current QuickPick collection from `extension.ts` into `RuntimeOpsSnapshotService`; retain cumulative versus
  delta semantics and source timestamps.
- [ ] Add cached PATH inventory with manual invalidation and union it with managed ledger runtimes.
- [ ] Render summary and dense runtime rows for availability, usage, last activity, and observed runtime version.
- [ ] Remove the QuickPick path only after the panel displays all information it previously exposed.

### Phase 3 - operational metrics

- [ ] Project live agent lifecycle, workspace provenance, attention/throttle/reset, model provenance, and resume readiness.
- [ ] Add a narrow Workspace accessor for current Bridge generation and per-agent client state; combine it with durable
  bound generation without exposing tokens, session ids, paths, or raw audit data.
- [ ] Render Bridge states (`ok`, `suspect`, `rebinding`, `failed`, `not wired`, `unknown`) and context-pressure
  unavailable reasons.
- [ ] Emit an append callback from `ActivityLogManager`, coalesce provider refreshes, and skip hidden-view work.
- [ ] Cover multi-root same-name agents, stale attention, generation mismatch, rebind failure, resumable/stopped agents,
  and deterministic sort order in pure tests.

### Phase 4 - responsive polish and dogfood

- [ ] Add the Runtime Ops webview bundle, design-system styles, preview route, and deterministic fixtures.
- [ ] Implement wide table and narrow labeled-row layouts using container width; preserve keyboard focus and readable
  unavailable explanations.
- [ ] Add browser tests for empty/error/loading/mixed/throttled/stale-Bridge states, long labels, overflow, and narrow view.
- [ ] Package/install a VSIX only after full verification and use the governed reload path when no other agents are active.
- [ ] Capture real VS Code evidence in the bottom panel and after moving the view to a sidebar; record fixes and verdict.
- [ ] After maintainer acceptance, create implementation tasks for the four phases and link them to this SDD.

## Verification

- [ ] The status item and compatibility command focus the contributed Runtime Ops panel.
- [ ] Projection tests prove source honesty, privacy exclusions, multi-root identity, and deterministic ordering.
- [ ] Provider tests prove visible event-driven refresh, hidden no-poll behavior, cache invalidation, and recovery states.
- [ ] Browser tests prove wide/narrow layout, keyboard navigation, and no page overflow.
- [ ] Full repository typecheck, unit/browser suite, engine-boundary, and production build pass.

**Headless check:** `npm run verify:full`
**Verify:** `npm run verify:full`

## Dogfood

**Dogfood-Opt-Out:** The defining behavior is a contributed VS Code bottom-panel WebviewView and cannot be exercised
meaningfully by a separate headless command beyond the declared full verification and preview/browser coverage.

**Human dogfood:** Install the verified VSIX with no other active agents, reload through the governed host action,
click `$(pulse) Runtime`, confirm the bottom panel is focused, compare displayed runtime/agent facts with the sidebar
and activity logs, trigger a throttle or use the fixture-backed development host, manually refresh, hide/reveal, then
move the view to a sidebar and inspect wide/narrow layouts.

## Visual QA

- [ ] Evidence: Runtime Ops preview screenshots for all fixtures and real VS Code bottom-panel/sidebar screenshots.
- [ ] Verdict: no clipped text, overlapping controls, horizontal page scroll, misleading availability, or stale hidden
  polling; any visual corrections are recorded in `notes.md`.
