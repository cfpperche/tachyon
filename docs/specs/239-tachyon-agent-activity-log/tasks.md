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

## Increment 3 — log store + single-writer + lineage
- [ ] `LoggedEvent` shape with `schemaVersion:1` + rich `source` (prefer `recordId` uuid) + inline boundary events.
- [ ] **One writer per agent** (singleton, Tachyon-owned) over the inc-2 iterator; panels are read-only subscribers. Idempotent append keyed `{runtime,sessionId,recordId||byteOffset,kind}`.
- [ ] `SessionLedger.lineage` field + append at write-points (spawn / Stop→refreshOwnership / resume) AND the **non-mutating session-change observer** (mid-run `/clear`); suppressed on shared cwd.
- [ ] Copy rendered blobs (content-addressed, deduped); maintain `.idx`.
- [ ] Backfill once (idempotent — re-enable safe): normalize existing owned sessions (oldest→newest).
- [ ] Unit tests: idempotent append (restart-mid-backfill + two concurrent writers/panels → stable count/order); provenance + blob dedup; lineage append/suppress; survives a simulated source prune (log still reads; "open raw" degrades).

## Increment 4 — render from the log (multi-session + virtualization)
- [ ] ActivityPanel reads from the log: latest page + `older(cursor)` across session boundaries via lineage.
- [ ] Heavy virtualization / windowed-tail (the deferred spec-238 inc 6, now required); memory bounded on multi-session feed.
- [ ] `session.boundary` separators; shared-cwd "stitching unavailable" notice.
- [ ] Unit tests: paging cursor (within + across sessions); shared-cwd notice path.

## Increment 5 — offset index perf (only if needed)
- [ ] `<agent>.idx` fast-path for O(1) paging; fall back to scan if absent/corrupt.
- [ ] Unit tests: index hit/miss/rebuild.

## Closure
**Closure:** _(filled at ship — acceptance boxes in spec.md checked, EDH validated, advisories clean)_
