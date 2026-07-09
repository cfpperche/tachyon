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
- The design remains draft until the three naming/compatibility/interaction defaults in `spec.md` are ratified. No
  implementation backlog cards should be created before that gate.
