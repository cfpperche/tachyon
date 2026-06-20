# Tasks 239 — agent activity log

**Verify:** `cd /home/goat/tachyon && env -u TMUX npx vitest run`
**UI impact:** ui

## Increment 1 — compaction boundary marker (render-only)
- [ ] Normalizer emits a `compact.boundary` event from the claude `compact_boundary` system record (trigger/pre/postTokens).
- [ ] activityView surfaces it as a boundary item; App.tsx renders a "context compacted (auto/manual)" separator.
- [ ] Unit tests: normalizer maps the boundary; view-model carries it; preview shows it.

## Increment 2 — EOF-bounded source iterator (shared primitive; 180 MB fix)
- [ ] Reusable backward, line-aware reader: last N complete records up to a snapshotted stable EOF (built so increment 3's writer reuses it, not throwaway panel code).
- [ ] ActivityPanel opens with the bounded tail (interim runtime-source read; superseded by the log subscription in inc 3/4 per D9); append tail starts at `snapshotEndOffset` (no dup/gap).
- [ ] Unit tests: backward reader (partial trailing line, block boundary, multi-byte UTF-8); no-dup/no-gap across snapshot→append.

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
