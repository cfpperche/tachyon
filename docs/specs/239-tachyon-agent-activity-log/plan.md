# Plan 239 — agent activity log

## Architecture

```
runtime transcript (canonical, runtime-owned)
        │  tail (existing incremental byte-offset reader)
        ▼
  per-runtime ActivitySource adapter  ── normalize ──▶  NormalizedEvent[]
        │                                                     │
        │ (capture-time, ledger write points)                │ append (+provenance +rendered blobs)
        ▼                                                     ▼
  SessionLineage (in SessionLedger)            .tachyon/activity/<agent>.jsonl  +  <agent>.idx
                                                              │  paged read (newest→oldest, EOF-bounded)
                                                              ▼
                                              ActivityPanel render (virtualized, spec 238)
```

The normalized per-agent log is the **single source of truth for render** and the **durable archive**. The runtime files stay canonical for "open raw" (via provenance) but are no longer the render path.

## Components

### 1. Log store — `.tachyon/activity/<agent>.jsonl` (+ `.idx`)
- Append-only JSONL of `LoggedEvent` = `NormalizedEvent` + `{ schemaVersion: 1, source, loggedAt }`. Boundary events are **inline** in the same log (`eventType:"boundary"`, normalized subtypes) — never a side stream (ordering + virtualization stay simple).
- Rendered blobs (image base64, tool diff/output bodies) stored content-addressed under `.tachyon/activity/blobs/<hash>`; the event references the hash. Dedup by hash.
- `<agent>.idx`: compact offset index (record N → byte offset, + session-boundary offsets) for O(1) paging without rescanning the log.
- Keyed by tachyon **agent name** (not cwd+uuid). Git-ignored.

### 2. Session lineage (extend `SessionLedger`)
- Add `lineage?: { sessions: Array<{ id: string; observedAt: string; startedAt?: string }> }` to `SessionRecord`.
- Append a uuid when an ownership refresh observes a **new** current session (spawn / Stop→refreshOwnership / resume). Order = Tachyon discovery (`observedAt`); `startedAt` = source first-record timestamp for display/sanity.
- **Suppressed on shared cwd** (reuse the existing `transcriptPathOf` shared-cwd detection). Never mutate lineage from the read path.

### 3. ActivitySource adapter (per runtime)
Capability-flagged interface so the log generalizes:
- `currentSession({cwd, configHome}) → sessionId | undefined` (safe-resolve only)
- `sourceLocator(sessionId) → path | handle`
- `pages`: `latest(n)`, `older(cursor)`, `appendTail(fromOffset)` — claude implements file/offset; another runtime may implement API/SQLite paging
- `normalize(record) → NormalizedEvent`
- `boundaries`: emit `session.boundary` / `compact.boundary`
- `caps`: `{ lineage, byteOffsets, backwardPaging, compactionMarkers }`

### 4. Writer (tail → normalize → append) — ONE per agent, Tachyon-owned
- **Ownership:** a singleton writer per agent owns backfill + live append; ActivityPanels are read-only subscribers (D9). The writer runs while the agent is live and/or a panel is open; panels never tail runtime files or backfill.
- **Idempotent append:** every event has a dedup key `{runtime, sessionId, recordId||byteOffset, kind}`. Backfill, live-tail, and recovery all write through the SAME append path, skipping already-seen keys → restart-mid-backfill / two-panel / writer-vs-tail races converge (R5).
- Reuses the existing incremental tail + `createClaudeNormalizer`. On each fresh batch: append normalized events with rich provenance (prefer `recordId` uuid), copy rendered blobs, update `.idx`.
- **Non-mutating session-change observer:** during tail, if the resolved current session uuid changes (a `/clear`/`/resume` with no Stop), the writer emits a `session.boundary` and queues the lineage append (through itself, never the render path) — this is how mid-run `/clear` is observed in time.
- **Backfill once** on enable: normalize the agent's existing owned sessions into the log (oldest→newest), idempotently (re-enable is safe).

### 5. Render data layer (ActivityPanel, spec 238)
- Read from the log, not the runtime file. Initial = latest page; scroll-back requests `older(cursor)` (within a session, then across session boundaries via lineage). Heavy virtualization + the deferred windowed-tail/host pagination (now required).
- Render `compact.boundary` and `session.boundary` as separators; shared-cwd → honest "stitching unavailable" notice.

## Data shapes (sketch)

```
LoggedEvent = NormalizedEvent & {
  schemaVersion: 1                                  // per-line version (D8)
  source: {                                         // provenance → canonical record (D2)
    runtime: string; sessionId: string;
    recordId?: string;        // claude record uuid — PREFERRED, stable across prune/rotate
    byteOffset?: number;      // locator optimization only
    sourcePath?: string;
    copiedBlobRef?: string;   // content-hash of a copied image/output blob
  }
  loggedAt: string
}
// boundary events — inline, eventType:"boundary"
{ ...boundary, eventType: "boundary", subtype: "compact", trigger: "auto"|"manual", preTokens, postTokens, source, loggedAt }
{ ...boundary, eventType: "boundary", subtype: "session", reason: "clear"|"resume"|"fresh", fromSession?, toSession, loggedAt }
// dedup key (idempotent append): `${runtime}:${sessionId}:${recordId ?? byteOffset}:${kind}`
```

## Sequencing → increments (confirmed)

1. **Compaction marker** — render `compact_boundary` as a separator (data already on disk; render-only; risk ~0).
2. **EOF-bounded source iterator** — a reusable backward/line-aware reader (last-N-from-stable-EOF + append tail from `snapshotEndOffset`). Wired into ActivityPanel now as an **interim runtime-source read path** (fixes 180 MB before the log exists; superseded by the log subscription in inc 3/4 per D9), but built as the **shared primitive increment 3's writer reuses** — not throwaway panel code (codex duet).
3. **Log + writer + lineage** — single per-agent writer over the inc-2 iterator: `.tachyon/activity/<agent>.jsonl` (+blobs, +rich provenance, +idx), idempotent append, backfill-once, lineage at write-points + the non-mutating session-change observer (unambiguous cwd).
4. **Render from log** — panels subscribe to the log; multi-session paging + heavy virtualization + session/shared-cwd notices.
5. **Offset index perf (C)** — only if paging proves slow.

Each increment: implement → codex review → EDH validate → commit. Increments 1–2 deliver value without the log.

**Verify:** `cd /home/goat/tachyon && env -u TMUX npx vitest run`
**UI impact:** ui (Activity render changes — boundaries, paging) — done-proof = unit tests + `activity-preview` + EDH (no web e2e for a VS Code webview).
