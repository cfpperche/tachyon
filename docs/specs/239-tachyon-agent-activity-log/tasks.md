# Tasks 239 — agent activity log

**Verify:** `cd /home/goat/tachyon && env -u TMUX npx vitest run`
**UI impact:** ui

## Increment 1 — compaction boundary marker (render-only) ✅
- [x] Normalizer emits a `compaction.boundary` event from the claude `compact_boundary` system record (trigger/pre/postTokens).
- [x] activityView surfaces it as a `boundary` item; App.tsx renders a "context compacted (· manual)" full-width separator (cv-consistent).
- [x] Unit tests: normalizer maps the boundary (auto + manual); view-model boundary item + token-delta detail; `activity-preview` shows 15 separators on a real transcript. Codex SHIP-WITH-CHANGES (cv fold applied).

## Increment 2 — EOF-bounded source iterator (shared primitive; 180 MB fix) ✅
- [x] Reusable backward, line-aware reader `src/activity/tailReader.ts` (`readTailWindow`): last N complete records up to a snapshotted stable EOF; byte-split + per-line decode; trailing `partial` carried as RAW BYTES (UTF-8-safe seam). Built for inc 3's writer to reuse.
- [x] ActivityPanel `primeFromTail` opens with the bounded tail (interim runtime-source read; superseded by the log subscription in inc 3/4 per D9); `consume` carries partial as bytes; append tail resumes at `endOffset` (no dup/gap). `MAX_TAIL_RECORDS=4000`.
- [x] Unit tests (10): backward reader (partial trailing line, multi-block, block-split + EOF-split multi-byte UTF-8, single-partial, empty); snapshot→append seam reconstruction; normalizer orphan tool_result degrades gracefully. Codex SHIP-WITH-CHANGES → UTF-8 byte-seam MAJOR folded + SEAM-FIXED confirmation. Interim note: summary/cap totals are window-scoped until the log (inc 3/4) restores cumulative history.

## Increment 3a — durable log foundation ✅
- [x] Provenance: `NormalizedEvent.recordId` (claude `uuid`), stamped in the normalizer.
- [x] `ActivityLog` (`src/activity/logStore.ts`): per-agent `.tachyon/activity/<agent>.jsonl`, NORMALIZED events (raw STRIPPED) + `schemaVersion:1` + provenance `source`; ONE atomic JSONL line per source record (crash → unparseable trailing line, never a half-logged record); `healTail`; idempotent per record; blobs content-addressed by sha256 (temp+rename); `readTail` reuses inc 2.
- [x] Tests: persist+drop-raw, idempotent-across-restart, atomic multi-event, crash torn-line recovery, sha256 blob dedup, survives source prune, empty. Codex BLOCK → atomic-record + sha256 folds → re-confirmed FIXED.

## Increment 3b — always-on writer + lineage ✅
- [x] `ActivityLogWriter` (per agent, pull-based `poll(cur)`): tails the current session forward into the log; session-uuid change → one `session.boundary` (unique transition id) + continue same log; first encounter = bounded TAIL (no 180MB block); **line-aligned per-session offset** (restart-safe, no `partial` persisted); `cur===undefined` (shared cwd/ambiguous) = gap, never guesses; logs only non-raw events.
- [x] `ActivityLogManager` (host, always-on from activation): one writer per resumable agent; slow-cadence cached resolve + cheap frequent ingest; reaps gone agents. Lineage = the writer's per-session offset state (no `SessionLedger` change needed). Sub-resolve-window A→B→A is a documented limit.
- [x] Tests: incremental/no-dup, boundary stitch, restart-resume, gap, toggle-boundary-uniqueness, mid-write-durability, no-raw. Codex BLOCK → 2 BLOCKERs (cursor-before-append, session-install-before-read) + durability folds (line-aligned offset, unique boundary ids) → re-confirmed COMPLETE.

## Increment 4 — render from the log ✅
- [x] ActivityPanel is a read-only subscriber to the per-agent log (`tailFrom` bounded initial + `forwardFrom` live, watchFile on the log); runtime tailing removed from the panel. Multi-session stitch is automatic (the log spans sessions); `session.boundary` renders as a separator.
- [x] Images loaded from the content-addressed blob store by `blobRef`. `content-visibility` virtualization (spec 238) covers offscreen paint; the log keeps the rendered window bounded.
- [x] e2e integration test: writer → log → render (2-session stitch + compaction marker + image blob, rendered from the log ONLY). Real 177MB smoke: 187ms bounded backfill, 33MB→3MB normalized log, raw stripped.

## Increment 6 — in-panel backward paging ("load earlier activity") ✅
- [x] `ActivityLog.tailFrom` returns `startOffset` (the backward-paging signal — `>0` = older records on disk).
- [x] Panel renders a bounded window (`windowRecords`/`shownItems`); a "Load earlier activity" button (driven by `hasOlder`) grows the shown items, re-reading a bigger window only when it outruns the in-memory one. Hard cap (`MAX_SHOWN_ITEMS=5000`/`MAX_WINDOW_RECORDS=40000`) beyond which it points to "open transcript" (bounds the payload).
- [x] Scroll stays anchored on prepend: the host marks only the paged VM `prepended` (one-shot); the webview compensates by the scroll-height delta on exactly that VM (a live append / imageData can't consume the anchor — codex MAJOR fold).
- [x] Tests: `tailFrom.startOffset` paging signal. Codex SHIP-WITH-CHANGES → anchor-determinism + payload-cap folds → re-confirmed SHIP. (EDH visual validation of the scroll-feel pending — the user's gate.)

## Increment 5 — offset index perf — DEFERRED BY DECISION (not an open follow-up)
Paging is offset-bounded via `readTailWindow`/`readForward` (real smoke: 187ms). The only full-scan is the writer's one-time `hydrate()` of the (normalized, bounded) log on start. No measured slowness → the `.idx` fast-path is deferred per the spec's "only if needed" gate. Revisit ONLY if a logged hydrate/paging slowness appears.

## Closure
**Closure:** Increments 1–4 shipped + committed (`531b0c4`, `8ffe4cf`, `d7b93f4`, `191bdbf`, `81eeeff`); inc 5 deferred by decision. Codex-reviewed every increment (BLOCK→folded→re-confirmed COMPLETE on 3a and 3b/4). 822 unit tests green; tsc (both) + engine-boundary + build clean; real-transcript smoke + e2e integration validated. **Decided v1 scope boundaries (not loose ends):** summary/cap totals are window-scoped ("recent" framing + Open-transcript escape hatch); capture is lineage-from-now (pre-existing deep history stays in the runtime file, reachable via Open-transcript); shared-cwd = documented gap (prefer-gap-over-misattribution); sub-resolve-window session flips outside the guarantee; a session.boundary is a render hint (a rare crash window may drop/dup one separator, content-safe). EDH visual validation is the user's gate (per every increment).
