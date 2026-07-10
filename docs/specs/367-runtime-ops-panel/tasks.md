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

- [x] Add the Runtime Ops webview bundle, design-system styles, preview route, and deterministic fixtures.
- [x] Implement wide table and narrow labeled-row layouts using container width; preserve keyboard focus and readable
  unavailable explanations.
- [x] Add browser tests for empty/error/loading/mixed/throttled/stale-Bridge states, long labels, overflow, and narrow view.
- [x] Package/install a VSIX only after full verification and use the governed reload path when no other agents are active.
  Detached VSIX `0.55.90` was built from commit `635ca46`, installed through code-server, and the governed reload
  action `3595c09a-f0a5-4553-a43f-095341205d48` is audit-confirmed `reattached_verified`.
- [x] Capture real VS Code evidence in the bottom panel and after moving the view to a sidebar; record fixes and verdict.
  Installed-host evidence: `.tachyon/evidence/runtime-ops-installed-bottom-panel.png` (restored narrow window),
  `.tachyon/evidence/runtime-ops-installed-bottom-panel-wide.png` (maximized wide table), and
  `.tachyon/evidence/runtime-ops-installed-sidebar.png` (human-moved right sidebar with narrow labeled rows).
  Verdict: PASS — live data, expanders, own scroll, no clipping/overlap/horizontal overflow.
- [x] After maintainer acceptance, create implementation tasks for the four phases and link them to this SDD:
  `t-6cadca` -> `t-880e49` -> `t-3b6ce6` -> `t-938cb8`.

## Verification

- [x] The status item and compatibility command focus the contributed Runtime Ops panel.
- [x] Projection tests prove source honesty, privacy exclusions, multi-root identity, and deterministic ordering.
- [x] Provider tests prove visible event-driven refresh, zero provider-owned intervals, hidden zero-push behavior,
  reveal refresh, cache invalidation, and recovery states.
- [x] Rebind lifecycle tests prove stale `cancelled` state cannot cross a new same-name process incarnation.
- [x] Browser tests prove wide/narrow layout, keyboard navigation, and no page overflow.
- [x] `npm run verify:full` passes the repository verification gate: 282 files, 3216 passed, and 3 skipped; the
  typecheck, engine-boundary, and production-build gates are green.
- [ ] The full `npm run test:browser` suite passes; seven unrelated failures remain: `taskPrototypeFrame` (1),
  `pinPreviewImageRender` (1), and `pilotBTaskStudio` (5). Follow-up task: `t-1c745f`.

**Headless check:** `npm run verify:full`
**Verify:** `npm run verify:full`

## Dogfood

**Dogfood:** `xvfb-run -a npx vscode-test --label single-root --run test/integration/runtimeOps.test.js`

**Human dogfood:** Install the verified VSIX with no other active agents, reload through the governed host action,
click `$(pulse) Runtime`, confirm the bottom panel is focused, compare displayed runtime/agent facts with the sidebar
and activity logs, trigger a throttle or use the fixture-backed development host, manually refresh, hide/reveal, then
move the view to a sidebar and inspect wide/narrow layouts.

## Visual QA

- [x] Advisory evidence: `.tachyon/vqa/visual-qa/runtime-ops-mixed-wide.png` (1280x633 capture of the 1100-wide
  frame) and `.tachyon/vqa/visual-qa/runtime-ops-long-label-narrow.png` (340x760 capture); wide is one dense table,
  narrow uses labeled flex rows with the header hidden, and measured narrow document/body `scrollWidth` equals
  `innerWidth` at 340.
- [x] Advisory verdict: `PASS` against the SDD intent, with no observed clipped text, overlapping controls, or
  horizontal page scroll in the captured wide/narrow frames.
- [x] Evidence: real installed VS Code bottom-panel/sidebar screenshots after VSIX install and current-window reload;
  see the installed-host evidence paths recorded in the Phase 4 dogfood checklist above.
