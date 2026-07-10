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
- The temporary internal QuickPick seam remains until Phase 3 projects normalized throttle state. It is not contributed
  or reachable from the public compatibility command; deleting it before throttle parity would discard an existing
  fact rather than complete the cutover.
