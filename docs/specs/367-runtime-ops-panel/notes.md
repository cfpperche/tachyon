# 367 - Runtime Ops panel - notes

_Created 2026-07-09._

## 2026-07-09 - planning findings

- `package.json` contributes only `viewsContainers.activitybar.tachyon`; there is no existing custom panel container to
  host Runtime Ops.
- No `createOutputChannel`/`OutputChannel` exists in `src/`. The screenshot's `TACHYON` lower-panel tab is not a
  reusable first-party view-container contract in this repository.
- The current status-bar QuickPick reads up to 5,000 durable activity events per managed agent on every open. That is
  acceptable for an explicit one-shot but not for a visible panel refresh loop.
- `ActivityLogManager` already performs incremental two-second ingestion but drops the `poll()` append count. A small
  append callback is the clean event seam for Runtime Ops without watching/re-reading every log.
- Existing `detectInstalledClis()` calls `which` for each known CLI. It is process-spawning presence detection, not a
  functional/authenticated check and not a version source.
- Normalized activity already preserves `runtimeVersion`; this is the only honest zero-extra-probe v1 version source.
- Bridge health requires both durable ledger binding and current coordinator state. A bound-generation match alone
  cannot represent an in-flight or failed rebind, while an in-memory state alone does not survive activation.
- The design remains draft until the four naming/compatibility/interaction/information-architecture defaults in
  `spec.md` are ratified. No implementation backlog cards should be created before that gate.

## 2026-07-09 - Claude review fold

Review artifact: `.tachyon/reviews/367-runtime-ops-panel-claude.md` (`FINDINGS`, no blockers).

- **M1 folded at the cause:** Phase 3 now requires a coordinator lifecycle hook that clears stale name-keyed
  `cancelled` state on a successful new process incarnation. The projection maps residual cancellation to `unknown`
  with a reason so the panel never lies while the lifecycle proof is absent.
- **M2 folded:** `src/webview/surfaces.ts` is now an explicit file and Phase 1 task, with the existing convention guard.
- Raw throttle `matchedLine` is excluded from the snapshot. Only normalized runtime/scope/reset metadata and fixed
  host-authored fallback copy may render.
- Duplicate workspace basenames receive shortest-unique-parent visible labels while full paths stay outside the VM.
- Hidden no-poll behavior is pinned by fake-timer/injected-source tests: no provider interval, zero hidden pushes, one
  fresh reveal push.
- Phases 1-3 are declared staging-only to prevent releasing an empty shell after the command redirect.
- A fourth maintainer ratification covers the single dense runtime table with expandable agent detail.

## 2026-07-09 - Claude re-review

Round 2 artifact: `.tachyon/reviews/367-runtime-ops-panel-claude-r2.md` (`ACCEPT`). Every round-1 finding and open
question is closed. The one non-blocking implementation note was folded: the new-incarnation hook clears only
`cancelled` and no-ops for `rebinding`, with a regression case for the coordinator's own internal resume path.

## 2026-07-09 - maintainer ratification and implementation queue

The maintainer ratified the four proposed decisions without changes: `Runtime Ops` / `Runtime` naming, compatibility
command reuse, read-only v1, and one dense runtime table with expandable agent detail. Spec status advanced to
`in-progress` and the implementation queue was materialized as:

1. `t-6cadca` - panel shell and entry point (`active`, assignee `codex`).
2. `t-880e49` - honest usage projection (depends on `t-6cadca`).
3. `t-3b6ce6` - agent, attention, session, and Bridge metrics (depends on `t-880e49`).
4. `t-938cb8` - responsive polish, browser coverage, and real-host dogfood (depends on `t-3b6ce6`).

The Bridge HTTP endpoint remained healthy, but this session's MCP client hung on handoff/task reads after the 0.55.90
dogfood update. The cards were therefore written directly to the local TaskStore and JSON-validated; no task semantics
were bypassed beyond the unavailable Bridge transport.

## 2026-07-09 - Phase 1 implementation evidence

- `xvfb-run -a npx vscode-test --label single-root --run test/integration/runtimeOps.test.js` passed against VS Code
  1.128.0. It proved the generated `workbench.view.extension.tachyonRuntimeOps` and
  `tachyonRuntimeOpsView.focus` commands exist, the compatibility command opens the container, and manual refresh
  executes in a real Extension Host without reloading the maintainer's active window.
- The `runtime-ops?fixture=empty` preview rendered the shipped bundle and typed fixture at 1100x360. Its accessibility
  snapshot exposed the Runtime summary and Runtime inventory regions with no page error or visible overflow.
- The provider has no timer, skips snapshot collection while hidden, republishes on reveal/ready/manual refresh, and
  invalidates an in-flight render when the view is disposed. Focus and lifecycle behavior are covered by focused tests.

## 2026-07-09 - Phase 2 usage projection

- `RuntimeOpsSnapshotService` now owns the bounded activity-log read and a 60-second coalescing PATH cache. Manual
  refresh invalidates detection; render never spawns a runtime `--version` probe.
- The pure projection unions PATH and ledger runtimes, preserves per-agent cumulative Codex versus delta Claude usage,
  sorts by display label, and exposes explicit unavailable reasons. The VM excludes full roots, transcript paths,
  session ids, raw activity payloads, and authentication claims.
- Duplicate workspace basenames use the shortest unique parent suffix. The browser fixture rendered Claude, Codex,
  and an installed-only Grok row at 1100x360 with no clipping or page error after webfont paint.
- The temporary internal QuickPick seam stayed in place until Phase 3 projected normalized throttle state. It was then
  removed; `tachyon.showRuntimeUsage` remains the compatibility entry point and opens Runtime Ops directly.

## 2026-07-09 - Phase 3 closure evidence

- Final review covered 280 focused tests, typecheck/build, and the integration `runtimeOps` host test; verdict: `ACCEPT`.
- Runtime Ops disclosure is label-bound: workspace labels use the shortest unique parent suffix, while tokens, session
  ids, full paths, raw audit payloads, authentication claims, and `matchedLine` remain outside the snapshot.
- Failure/recovery semantics are covered for fixed privacy-safe snapshot errors, visible event-driven refresh, hidden
  zero-push behavior, reveal recovery, Bridge generation mismatch, rebind failure, and stale `cancelled` state.
- Phase 4 remains pending for the catalog/l10n and engine-boundary gates, browser/full-repository verification, visual
  evidence, packaging, and real-host dogfood. This closure does not claim full verify or real visual dogfood.

## 2026-07-09 - Phase 4 preview and browser evidence

- The Runtime Ops preview route now has typed `loading`, `empty`, `error`, `mixed`, `throttled`, `stale-bridge`,
  `long-label`, and `duplicate-workspace` fixtures, plus the existing `default` alias. `loading` uses an explicit
  `runtimeOpsLoading` host message rather than treating fixture absence as a snapshot.
- The single inventory table remains the only primary layout. Its rows use a container query: the `1100x360` preview
  uses the dense grid table, while the `340x760` preview reflows each runtime and agent row into labeled fields.
  Browser checks prove no document or cell horizontal overflow in both placements.
- Presentation is deliberately defensive: the public snapshot has no free-form unavailable `reason`, availability
  `detail`, Bridge/resume reason, or throttle `message` fields. Throttle runtime (`claude`, `codex`, `opencode`) and
  scope (`5h`, `weekly`) are closed protocol unions; the projection drops other values, and the webview renders each
  retained value through fixed switch copy. Models likewise require an allowlisted display label. A raw or unknown
  throttle runtime/scope is represented only by fixed unavailable copy, never by the source string.
- Passed gates: `npm run preview:webview:catalog`; `npx vitest run test/unit/webviewPreviewRoutes.test.ts` (17/17);
  `npm run typecheck`; `npm run build`; and
  `npx vitest run --config vitest.browser.config.ts test/browser/runtimeOpsView.test.ts` (3/3). The browser test
  exercises state fixtures, stale-Bridge fixed copy, keyboard `summary` toggle/focus, and wide/narrow overflow.
- The full `npm run test:browser` is not green because existing out-of-slice tests fail: `pilotBTaskStudio.test.ts`
  waits for `.ts-fields`, and `taskPrototypeFrame.test.ts` observes no iframe scroll. A serial rerun confirms the same
  two failures; `pinPreviewImageRender.test.ts` passes serially. No files for those surfaces were changed here.
- VSIX packaging/install and Extension Development Host reload were not attempted because other agents are active.
- Human dogfood remains: with no active agents, install the verified VSIX, use the governed reload path, inspect Runtime
  Ops in the bottom panel and sidebar, and capture the real-host screenshots required by the Phase 4 task.

## 2026-07-10 - P1 snapshot protocol privacy correction

- The snapshot builder is the normalization boundary, not TypeScript declarations alone. It validates closed throttle
  unions, allowlisted model labels/sources, finite positive reset/generation values, finite token counts, ISO timestamps,
  and a bounded version grammar before creating `RuntimeOpsSnapshotV1`. Unknown model data becomes unavailable; unknown
  throttle runtime/scope is omitted; raw context/resume/reason text is not part of the protocol.
- `runtimeOpsModel.test.ts` constructs one hostile input containing raw throttle runtime/scope/message, model
  value/reason, context reason, matched line, session, path, and token sentinels and proves none occur in serialized
  snapshot data. `runtimeOpsSnapshotService.test.ts` additionally proves monitor matched text, tmux/session identity,
  and workspace root are absent from the service snapshot.
- The `throttled` browser fixture sends those hostile values through `buildRuntimeOpsSnapshot`, then checks both rendered
  text and full HTML for every marker. It also includes an allowlisted Codex five-hour throttle row: fixed `Codex` /
  `5-hour window` copy remains visible, while the hostile row renders only fixed unavailable runtime/scope copy plus its
  valid reset time.
- Current focused verification passed: `npx vitest run test/unit/runtimeOpsModel.test.ts
  test/unit/runtimeOpsSnapshotService.test.ts test/unit/runtimeOpsView.test.ts` (36/36),
  `npm run preview:webview:catalog`, `npm run typecheck`, `npm run build`,
  `npx vitest run --config vitest.browser.config.ts test/browser/runtimeOpsView.test.ts` (3/3), and `git diff --check`.

## 2026-07-10 - Phase 4 final evidence

- Local advisory visual QA persisted `.tachyon/vqa/visual-qa/runtime-ops-mixed-wide.png` (1280x633 capture of the
  1100-wide frame) and `.tachyon/vqa/visual-qa/runtime-ops-long-label-narrow.png` (340x760). The wide frame is one
  dense table; the narrow frame uses labeled rows, with the header hidden. Measured narrow document/body `scrollWidth`
  equals `innerWidth` at 340, and the narrow layout uses flex rows. Verdict: `PASS` against the SDD intent.
- Final gates passed: `npm run preview:webview:catalog`; `npm run typecheck`; `scripts/check-engine-boundary.sh` (`OK`);
  focused Runtime Ops browser tests (3/3); real VS Code host smoke (1/1); and `npm run verify:full` (282 files,
  3216 passed, 3 skipped).
- The full `npm run test:browser` command still has two unrelated pre-existing failures, so this evidence does not
  claim that the entire browser suite passes. VSIX install/current-window reload and real installed bottom-panel/sidebar
  screenshots were deferred at this stage and are closed by the installed dogfood evidence below.

## 2026-07-10 - Installed Runtime Ops dogfood closure

- A clean detached VSIX `0.55.90` was built from committed head `635ca46` and installed through code-server after the
  verification gates completed. The current-window governed reload action
  `3595c09a-f0a5-4553-a43f-095341205d48` is audit-confirmed with status `reattached_verified`.
- Real installed-host evidence is recorded at `.tachyon/evidence/runtime-ops-installed-bottom-panel.png` (restored
  narrow window), `.tachyon/evidence/runtime-ops-installed-bottom-panel-wide.png` (maximized wide table), and
  `.tachyon/evidence/runtime-ops-installed-sidebar.png` (human-moved right sidebar; narrow labeled rows).
- Visual verdict: PASS. The installed surface showed live data, working expanders, an owned scroll region, and no
  clipping, overlap, or horizontal overflow. This closes the package/install and screenshot dogfood checklist items.
- The full `npm run test:browser` suite is not claimed green: two unrelated pre-existing tests remain red
  (`pilotBTaskStudio.test.ts` waits for `.ts-fields`; `taskPrototypeFrame.test.ts` observes no iframe scroll).
- Release/publish claims remain unproven and intentionally pending. `git diff --check` passed for this documentation
  update.

## 2026-07-10 - SDD closure status

- Status is `shipped-partial`: all Runtime Ops acceptance criteria are supported by focused tests, `verify:full`,
  focused browser coverage (3/3), and installed VSIX bottom-panel/sidebar evidence.
- The global `npm run test:browser` criterion remains intentionally unchecked. The latest full suite has seven
  unrelated failures: `taskPrototypeFrame` (1), `pinPreviewImageRender` (1), and `pilotBTaskStudio` (5).
- Browser-suite debt is tracked by follow-up task `t-1c745f`; no production-code or `tachyon.yml` changes are part of
  this closure.
