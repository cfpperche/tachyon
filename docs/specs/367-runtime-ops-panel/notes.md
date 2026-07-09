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
