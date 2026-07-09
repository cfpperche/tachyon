# 367 - Runtime Ops panel - plan

_Drafted from `spec.md` on 2026-07-09. The approach, not the steps (those go in `tasks.md`)._

## Approach

Build a window-level Runtime Ops projection and render it through one statically contributed bottom-panel
`WebviewView`.

1. Add a custom `viewsContainers.panel` container (`tachyonRuntimeOps`) with one webview view
   (`tachyonRuntimeOpsView`). The current `tachyon.showRuntimeUsage` command and status-bar item reveal this
   container, preserving command/keybinding compatibility while replacing the transient QuickPick.
2. Extract the current usage collection out of `extension.ts`. A host-side `RuntimeOpsSnapshotService` gathers
   allowlisted facts from configured workspaces and hands pure inputs to a projection builder. The builder produces
   a versioned `RuntimeOpsSnapshotV1`; the webview never reads workspace files or runtime state directly.
3. Render a dense runtime table, not a dashboard of cards. A compact summary strip shows detected runtimes, live
   agents, throttles, and Bridge issues. Each runtime row shows availability and usage first, followed by live-agent
   and operational fields. At narrow widths the row becomes a labeled two-column detail grid. This information
   architecture is a maintainer ratification gate, not an implementation default hidden in the plan.
4. Refresh from existing state-change fan-out plus normalized activity append events. Coalesce bursts, skip pushes
   while the view is hidden, refresh on reveal, and cache PATH detection. Manual refresh invalidates the detection
   cache and rebuilds the snapshot. No interval reads every activity log.
5. Ship in four implementation slices: panel shell and entry point; honest usage rows; agent/Bridge/session ops;
   responsive polish and real-host dogfood.

### Information architecture

The view has one level of navigation and no nested cards:

- **Summary strip:** runtime count, active agent count, throttled count, Bridge issue count, snapshot timestamp.
- **Runtime rows:** runtime/status, usage and its semantics, agents/workspaces, attention, Bridge binding, model,
  resume readiness, last activity, observed runtime version, context pressure or its unavailable reason.
- **Agent detail:** compact child rows shown under a runtime when more than aggregate data is needed. Same-named
  agents are qualified by workspace.
- **States:** skeleton on first load, empty PATH/fleet state, recoverable snapshot error, stale-source badge, and
  explicit unavailable cells.

### Data sources and honesty rules

| Field | Source | Rule |
| --- | --- | --- |
| Runtime inventory | `detectInstalledClis()` plus `SessionLedger.resume.runtime` | Union the sets; PATH detection means installed only, never authenticated or functional. |
| Usage | `.tachyon/activity/<agent>.jsonl` `usage.updated` events through `buildRuntimeUsageSource()` | Keep the existing Codex cumulative and Claude delta semantics. Show the source and latest event time. Missing is unavailable, not zero. |
| Runtime version | Latest normalized activity event `runtimeVersion` | Last observed only. Do not spawn `--version` from the render path. |
| Agent lifecycle | `AgentManager.list()` | Preserve running, stopping, stop-failed, stopped, and crashed. Filter terminal-kind entries. |
| Attention/rate limit | `Workspace.attentionOf()` | Preserve state and stale flag. For throttles, project only normalized runtime/scope/reset metadata and render a fixed `Throttled - see agent terminal` fallback; never serialize `matchedLine`. Do not turn idle into quota data. |
| Model | Existing `modelFromCommand()` and runtime-profile fallback | Label fallback as configured/default, not observed, when no command flag exists. |
| Resume readiness | `SessionLedger` plus `isResumable()` | Distinguish resumable, fresh-start-only, and currently live. Never expose session ids or config-home paths. |
| Bridge health | Current coordinator generation, ledger `bridgeClient`, `durableBoundGeneration()`, and coordinator client state | `ok` requires wired and bound to the current generation. Lower generation is suspect/stale; absent wiring is not wired. A successful start/restart/resume resets name-keyed state for the new incarnation. A residual `cancelled` maps to `unknown` with a reason. Expose generations only in detail/tooltips. |
| Context pressure | A future normalized `{used, limit, source}` input | V1 shows unavailable unless both used and limit are present from one trustworthy source. Cumulative usage is not context pressure. |
| Workspace | `Workspace.folderName`, root path, and `wsHash` | Use hash only as an opaque UI key. Render the basename unless duplicates exist; then append the shortest unique parent-path suffix without exposing the full absolute path. |

`RuntimeOpsSnapshotV1` is allowlist-by-construction. It excludes terminal contents and raw throttle lines entirely,
plus transcript paths, session ids, environment, Bridge tokens, config-home paths, full absolute workspace paths,
and raw activity payloads.

## Key decisions

- **Use a dedicated panel View Container.** The repository currently contributes only the Tachyon Activity Bar
  container; there is no reusable Tachyon `viewsContainers.panel` host. A dedicated container gives the requested
  Problems/Terminal-class bottom tab and remains movable by the user. Reusing the screenshot's `TACHYON` tab is
  rejected because no corresponding panel contribution or OutputChannel exists in this codebase.
- **Use `WebviewView`, not editor `WebviewPanel`.** A contributed view belongs to the bottom-panel layout, is
  focusable by its generated container command, and can move between Panel and Sidebars. An editor panel would open
  in the document area. A TreeView is rejected because the required dense, multi-column sourced metrics and
  responsive unavailable explanations exceed a hierarchical list without replacing it with custom detail views.
- **One container, one view.** Runtime and agent data are two levels of the same operational projection. Separate
  panel views would fragment scanning and move each view's actions into separate toolbars. This remains proposed
  until the maintainer ratifies the dense-table information architecture.
- **Read-only v1.** The first release proves data truthfulness, refresh behavior, and layout. Lifecycle buttons,
  Bridge repair, credential flows, and quota actions are deferred because they introduce authority and confirmation
  requirements unrelated to observing runtime health.
- **Event-driven visible refresh.** Reuse `onViewsChanged("agents")`, add a callback when `ActivityLogManager` appends
  normalized events, and refresh on view reveal/workspace changes. A permanent UI timer is rejected because it
  rereads durable logs while hidden and scales with agent count. Provider tests use fake timers and injected sources
  to assert that no interval is registered and hidden state changes produce zero pushes until reveal.
- **Normalize throttle copy at the trust boundary.** `AttentionMonitor.matchedLine` is free-form terminal content.
  Runtime Ops consumes only normalized `rateLimit` metadata and fixed host-authored copy; raw matched lines never enter
  `RuntimeOpsSnapshotV1`.
- **Reset rebind state by incarnation.** `BridgeClientRebindCoordinator` is currently keyed by agent name, so an old
  `cancelled` can survive ordinary same-name restart. Add an explicit lifecycle hook after successful
  spawn/restart/resume to reset the coordinator entry for the new incarnation. The hook resets only an existing
  `cancelled` state; it must no-op for `rebinding`, because the same `onSpawned` seam also fires inside the
  coordinator's own resume flow before that flow finalizes `rebinding -> ok`. Until reset is proven, the projection
  maps residual `cancelled` to `unknown`, not `ok` or `failed`.
- **Cache detection; observe version.** Existing `detectInstalledClis()` actually spawns `which` once per known CLI;
  it is not spawn-free and returns no version. Cache this inventory for 60 seconds and derive version only from the
  latest normalized `runtimeVersion` event. A render-triggered `--version` fan-out is deferred.
- **Stateless webview.** The host owns the snapshot and re-sends it on resolve/reveal. The webview may persist only
  presentation preferences such as expanded rows. `retainContextWhenHidden` is rejected because VS Code documents
  its higher memory cost and recommends serializable state for cheap-to-recreate views.
- **Preserve the command id.** `tachyon.showRuntimeUsage` becomes the open/focus command so existing keybindings and
  command links keep working. Renaming its displayed title to `Tachyon: Open Runtime Ops` can be a package-level UX
  change without breaking the API id.

## Files touched

- `package.json`, `package.nls.json`, `package.nls.pt-br.json` - contribute the panel container/view, update command
  copy, and add a refresh view-title action.
- `src/runtimeOps/types.ts` - versioned host-to-webview snapshot contract and source/unavailable metadata.
- `src/runtimeOps/model.ts` - pure deterministic runtime/agent projection builder.
- `src/runtimeOps/snapshotService.ts` - cached detection and workspace/activity collection with coalesced refresh.
- `src/runtimeUsage/model.ts` - retain and reuse the existing honest cumulative/delta usage primitives; only extend
  source metadata needed by Runtime Ops.
- `src/workspace/Workspace.ts` - expose a narrow read-only Bridge generation/client-health projection rather than the
  private coordinator and route successful agent-incarnation lifecycle events to the rebind coordinator.
- `src/bridge/clientRebind.ts` - add a new-incarnation reset hook and test stale `cancelled` cleanup on ordinary
  start/restart/resume paths.
- `src/webview/ActivityLogManager.ts` - emit a bounded append notification when normalized activity was persisted.
- `src/webview/RuntimeOpsView.ts` - `WebviewViewProvider`, visibility lifecycle, CSP shell, messages, and refresh.
- `src/webview/surfaces.ts` - register `tachyonRuntimeOpsView` in the canonical first-party webview manifest.
- `src/webview/runtime-ops/{main.tsx,App.tsx,messages.ts,runtime-ops.css}` - responsive first-party UI.
- `src/extension.ts` - instantiate/register the provider, route status-bar/open/refresh commands, and remove the
  QuickPick collector after parity.
- `esbuild.mjs` - build and copy the Runtime Ops webview bundle/styles.
- `scripts/webview-preview/{routes.ts,fixtures/runtime-ops.ts,routes.json}` - deterministic visual fixtures.
- `test/unit/{runtimeOpsModel,runtimeOpsSnapshotService,runtimeOpsView}.test.ts` - projection, source, cache, lifecycle,
  and command coverage.
- `test/browser/runtimeOpsView.test.ts` - wide/narrow rendering, states, keyboard, and overflow checks.

## Risks & unknowns

- The generated focus command for a custom panel container is used elsewhere as
  `workbench.view.extension.<containerId>` but is not a typed VS Code API. Prove the exact command in the shell slice
  and keep a fallback that calls the contributed view's focus command if required.
- Activity logs can be large. Initial hydration must remain bounded and subsequent refresh must consume append
  notifications or cached cursors rather than rereading 5,000 events per agent on every state change.
- Multi-root and same-name agents can accidentally collapse if keys use only agent name. All keys must include
  workspace hash plus agent name; duplicate visible basenames also require shortest-unique-parent disambiguation.
- Bridge coordinator state is partly in-memory while bound generation is durable. The snapshot must distinguish
  unknown after activation from healthy and must not make the test/debug coordinator API a broad public dependency.
  Its name-keyed map must reset when a new process incarnation starts, or stale `cancelled` state becomes user-visible.
- Runtime profiles expose default model labels whose source is declared, not observed. The UI must preserve that
  provenance.
- A movable WebviewView can become much narrower than the bottom panel. The layout must use container-width behavior,
  not viewport assumptions.
- Package contribution changes require a real VS Code reload for dogfood. Reload safety must honor the active-agent
  precondition added in `d737c90`.
- Phases 1-3 are implementation staging and must not be packaged or released independently: Phase 1 redirects the
  compatibility command before Phase 2 restores QuickPick parity. Only the integrated Phase 1-4 result is dogfooded.

## Visual impact

The status bar changes from `Usage` to `Runtime` and opens a new bottom-panel tab titled `Runtime Ops`. The view is
an operational table using the shared VS Code theme and Tachyon design-system tokens, with no decorative hero or
card grid. Visual risk is concentrated in narrow placements, long runtime/agent names, many workspace-qualified
agents, unavailable-reason wrapping, theme contrast, and panel-height compression.

Preview fixtures must cover empty, mixed healthy, throttled, stale Bridge generation, long names, and source-error
states at wide and narrow widths. Final proof is a real installed VSIX screenshot in the bottom panel plus the same
view dragged to a sidebar; verify no overlap, clipping, or horizontal page scroll.

## Sources consulted

- `package.json:416-442` - current Activity Bar container and two webview views; no panel container.
- `src/extension.ts:166-222, 590-624, 1896-1898` - current QuickPick collectors, status item, and command.
- `src/runtimeUsage/model.ts` and `test/unit/runtimeUsage.test.ts` - cumulative/delta and throttle honesty contract.
- `src/workspace/Workspace.ts:218-305, 1657-1663` - workspace-owned manager, ledger, monitor, Bridge, and attention.
- `src/bridge/clientRebind.ts:189-301` and `src/resume/SessionLedger.ts` - current/bound Bridge generation and client state.
- `src/runtime/runtimeProfile.ts:1-270` and `src/sidebar/agentModel.ts:1-128` - model/profile provenance and agent state.
- `src/webview/ActivityLogManager.ts` and `src/activity/logStore.ts:91-216` - bounded durable activity ingestion/read seam.
- `src/webview/surfaces.ts` and `test/unit/webviewConvention.test.ts` - canonical surface manifest and guard.
- `docs/specs/349-plugin-ui-surfaces/{plan,notes}.md` - static `WebviewView` contribution precedent.
- VS Code Contribution Points: https://code.visualstudio.com/api/references/contribution-points
- VS Code Panel UX Guidelines: https://code.visualstudio.com/api/ux-guidelines/panel
- VS Code Webview API: https://code.visualstudio.com/api/extension-guides/webview
- VS Code Webview UX Guidelines: https://code.visualstudio.com/api/ux-guidelines/webviews
