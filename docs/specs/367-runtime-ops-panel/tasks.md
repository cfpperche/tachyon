# 367 - Runtime Ops panel - tasks

_Generated from `plan.md` on 2026-07-09. Work top-to-bottom. If a task reveals the plan is wrong, update
`plan.md` before continuing._

## Implementation

### Phase 1 - panel shell and entry point

- [x] Add the `tachyonRuntimeOps` panel container, `tachyonRuntimeOpsView`, localized labels, and refresh view action.
- [x] Register `tachyonRuntimeOpsView` in `src/webview/surfaces.ts` as a converted live first-party surface and keep
  the webview convention/catalog guard green.
- [x] Implement/register `RuntimeOpsViewProvider` with the shared CSP shell and an empty typed snapshot.
- [x] Change `tachyon.showRuntimeUsage` and the `$(pulse) Runtime` status item to reveal/focus the contributed panel;
  prove the generated command id in a real Extension Development Host.
- [x] Add provider lifecycle tests for resolve, hidden/reveal, ready, refresh, dispose, and no-workspace states.

### Phase 2 - honest usage projection

- [x] Define `RuntimeOpsSnapshotV1`, source metadata, unavailable reasons, and runtime/workspace/agent keys.
- [x] Extract current QuickPick collection from `extension.ts` into `RuntimeOpsSnapshotService`; retain cumulative versus
  delta semantics and source timestamps.
- [x] Add cached PATH inventory with manual invalidation and union it with managed ledger runtimes.
- [x] Build workspace display labels that use the basename normally and the shortest unique parent-path suffix when
  two open roots share a basename; keep full paths out of the snapshot.
- [x] Render summary and dense runtime rows for availability, usage, last activity, and observed runtime version.
- [x] Remove the QuickPick path only after the panel displays all information it previously exposed.

### Phase 3 - operational metrics

- [x] Project live agent lifecycle, workspace provenance, attention/throttle/reset, model provenance, and resume
  readiness; serialize only normalized throttle metadata and fixed copy, never `matchedLine`.
- [x] Add a narrow Workspace accessor for current Bridge generation and per-agent client state; combine it with durable
  bound generation without exposing tokens, session ids, paths, or raw audit data.
- [x] Add a `BridgeClientRebindCoordinator` new-incarnation hook called after successful start/restart/resume; reset
  only stale name-keyed `cancelled` state. Test both suspect -> user stop -> ordinary same-name restart and a
  coordinator-initiated rebind resume, proving the latter remains `rebinding` until its own finalize step.
- [x] Render Bridge states (`ok`, `suspect`, `rebinding`, `failed`, `not wired`, `unknown`); map any residual
  `cancelled` to `unknown` with a reason and render context-pressure unavailable reasons.
- [x] Emit an append callback from `ActivityLogManager`, coalesce provider refreshes, and skip hidden-view work.
- [x] Prove with fake timers and injected refresh/detection sources that the provider registers no interval, hidden
  changes trigger zero pushes, and one fresh snapshot is published on reveal.
- [x] Cover multi-root same-name agents, stale attention, generation mismatch, rebind failure, resumable/stopped agents,
  and deterministic sort order in pure tests.

### Phase 4 - responsive polish and dogfood

Phases 1-3 are staging only and must not be packaged, released, or dogfooded independently. The compatibility command
redirect ships only with the integrated Phase 1-4 result after usage parity is restored.

- [ ] Add the Runtime Ops webview bundle, design-system styles, preview route, and deterministic fixtures.
- [ ] Implement wide table and narrow labeled-row layouts using container width; preserve keyboard focus and readable
  unavailable explanations.
- [ ] Add browser tests for empty/error/loading/mixed/throttled/stale-Bridge states, long labels, overflow, and narrow view.
- [ ] Package/install a VSIX only after full verification and use the governed reload path when no other agents are active.
- [ ] Capture real VS Code evidence in the bottom panel and after moving the view to a sidebar; record fixes and verdict.
- [x] After maintainer acceptance, create implementation tasks for the four phases and link them to this SDD:
  `t-6cadca` -> `t-880e49` -> `t-3b6ce6` -> `t-938cb8`.

## Verification

- [x] The status item and compatibility command focus the contributed Runtime Ops panel.
- [x] Projection tests prove source honesty, privacy exclusions, multi-root identity, and deterministic ordering.
- [x] Provider tests prove visible event-driven refresh, zero provider-owned intervals, hidden zero-push behavior,
  reveal refresh, cache invalidation, and recovery states.
- [x] Rebind lifecycle tests prove stale `cancelled` state cannot cross a new same-name process incarnation.
- [ ] Browser tests prove wide/narrow layout, keyboard navigation, and no page overflow.
- [ ] Full repository typecheck, unit/browser suite, engine-boundary, and production build pass.

**Headless check:** `npm run verify:full`
**Verify:** `npm run verify:full`

## Dogfood

**Dogfood:** `xvfb-run -a npx vscode-test --label single-root --run test/integration/runtimeOps.test.js`

**Human dogfood:** Install the verified VSIX with no other active agents, reload through the governed host action,
click `$(pulse) Runtime`, confirm the bottom panel is focused, compare displayed runtime/agent facts with the sidebar
and activity logs, trigger a throttle or use the fixture-backed development host, manually refresh, hide/reveal, then
move the view to a sidebar and inspect wide/narrow layouts.

## Visual QA

- [ ] Evidence: Runtime Ops preview screenshots for all fixtures and real VS Code bottom-panel/sidebar screenshots.
- [ ] Verdict: no clipped text, overlapping controls, horizontal page scroll, misleading availability, or stale hidden
  polling; any visual corrections are recorded in `notes.md`.
