# Spec 239 — Tachyon agent activity log (durable, normalized history)

**Status:** draft · **Date:** 2026-06-20 · **Follows:** spec 238 (Activity view) · **Runtime scope:** claude v1, runtime-agnostic by design

## Problem

The Activity view (spec 238) renders a claude agent by tailing its on-disk transcript, resolved live to the agent's **current** session file. That breaks the moment the runtime rotates which file the terminal writes to — and the user requires the Activity view to **durably persist ALL of a tachyon agent's activity**, surviving runtime-side pruning.

Empirical findings (verified on 170 real claude transcripts — authoritative for the user's claude version, stronger than docs):

- **Compaction is NOT a loss.** `/compact` and auto-compact append a `system` record `subtype:"compact_boundary"` (`compactMetadata{trigger, preTokens, postTokens, preservedSegment}`) and keep writing to the **same** file; all pre-compaction records remain (one 180 MB file held 15 compactions). The view already tails the full pre+post history. → only opportunity: a visual boundary marker.
- **`/clear`, `/resume <other>`, fresh start → a different file.** Every file's first record has `parentUuid:null`; there are **zero** `summary` records → the runtime keeps **no cross-file lineage**. The live resolver follows newest-by-cwd → prior sessions are orphaned from the view (still on disk, until the runtime prunes them).
- **The current session file is already 180 MB.** The host reads from offset 0 and normalizes the whole file on every panel open (then caps posted items to 600). A present single-session scaling problem, independent of multi-session.

## Goal

A **normalized, append-only activity log per tachyon agent** — `.tachyon/activity/<agent>.jsonl` — fed by tailing the runtime's canonical transcript through the existing normalizer. It is simultaneously:
1. the **durable archive** (survives /clear, /resume, fresh starts, and runtime pruning), and
2. the **render source** for the Activity view (compact, paginable) — collapsing the 180 MB-on-open, multi-session stitch, and multi-runtime problems into one model.

This is "our own store" in spirit — but a **normalized projection + provenance pointers**, NOT a raw clone.

## Decisions

- **D1 — Own log, normalized not cloned.** Persist `NormalizedEvent`s (messages, thinking, tools, files, usage, images, boundaries), ~the render spine. The raw runtime file is ~80% UI-state sidecar (`mode`/`permission-mode`/`ai-title`/`custom-title`/`last-prompt`/`queue-operation`/`file-history-snapshot`); we drop that.
- **D2 — Fidelity bar (user decision): no raw, pointers yes.** Each event carries rich provenance `source:{runtime, sessionId, recordId?, byteOffset?, sourcePath?, copiedBlobRef?}` back to the canonical record. **Prefer the claude record UUID (`recordId`) over `byteOffset`** (offsets break on prune/rotate/rewrite; the uuid is stable); byteOffset is a locator optimization only. We **copy the blobs we render** (image base64, tool diffs/outputs) into our store so they survive runtime pruning; everything else is pointer-only. **"Open raw" degrades gracefully**: when the source file is gone it shows "source unavailable — rendered copy preserved", never a dead link (codex duet, High).
- **D8 — Log is versioned per line.** Every `LoggedEvent` carries `schemaVersion: 1`. Per-line (not a header record) so the append-only JSONL survives partial reads/truncation and tolerates mixed-version logs across upgrades without a migration step (codex duet, High).
- **D9 — One writer per agent, not per panel.** A single Tachyon-owned writer per agent owns backfill + live append; ActivityPanels are **read-only subscribers** to the log (they never backfill or tail runtime files). Two panels open for one agent must not duplicate rows (codex duet, High). **Staging:** this is the end-state from increment 3 on. Increment 2 ships before the log exists, so its panel reads the runtime source directly via the shared iterator — an explicitly **interim** path, superseded once the log lands in increment 3/4 (codex duet round 2).
- **D3 — Identity at capture, keyed by agent.** Lineage (the ordered set of session uuids an agent owned) is appended at **ledger write points** (spawn / Stop→refreshOwnership / resume) AND by a **non-mutating session-change observer** in the writer (a `/clear` followed by continued work fires no Stop, so write-points alone miss it; the observer detects "current session changed" during tail and queues the lineage write **through the writer owner**, never from the render read path) (codex duet, High). The log is keyed by tachyon agent, not by (cwd, uuid).
- **D4 — Shared-cwd = documented gap, prefer-gap-over-misattribution.** Where ≥2 agents share a cwd, capture is suppressed (consistent with the existing disambiguation gate) and the UI says so. **Never guess by newest-by-cwd there.**
- **D5 — Log is the durable archive; no destructive truncation.** Render-side bounds (600 cap, content-visibility, pagination) are NOT storage bounds. Storage grows by design (per-agent + normalized keeps it manageable); an optional retention knob defaults to keep-all.
- **D6 — Runtime-agnostic via the normalizer boundary + a per-runtime adapter** (current-session identity, source locator, record page API latest/older/append, boundary events, capability flags). claude = file/offset; another runtime may be API/SQLite/none. The normalized log is identical across runtimes.
- **D7 — Render reads from the log**, paged from newest→oldest with EOF-bounded initial read + heavy virtualization.

## Non-goals

- Raw transcript cloning (D1/D2).
- Retention/truncation of the archive (D5) — only an optional opt-in knob.
- Shared-cwd attribution (D4).
- Observability dashboards / forensics (harness-drift).
- Multi-runtime normalizers beyond claude in v1 (the log shape is ready; other adapters land on demand).

## Risks

- **R1 (highest) — misattribution.** Showing another agent's work as this agent's is worse than missing history. Concentrated at shared cwd + newest-by-cwd + resume races. Mitigation: capture only at ledger write points on unambiguous cwd; prefer a gap.
- **R2 — backward JSONL read traps** (partial trailing line, block boundaries). Mitigation: byte/line-aware backward read; snapshot a stable EOF; ignore the trailing partial until the append tail completes it.
- **R3 — storage growth.** Mitigation: normalized + per-agent; optional retention knob; index for paging.
- **R4 — blob copy cost** (image/output duplication). Mitigation: copy only rendered blobs; content-hash dedup.
- **R5 — duplicate/missing events on crash or concurrency** (restart mid-backfill; two panels; writer racing the live tail). Mitigation: single writer per agent (D9); idempotent append keyed on `{runtime, sessionId, recordId||byteOffset, kind}` — backfill + live converge through one append path that skips already-seen keys (codex duet, High).

## Acceptance

- [x] A compaction boundary renders as a visual separator in the current session. *(inc 1)*
- [x] Panel open no longer full-reads a 180 MB file: initial read is bounded (last N records from a stable EOF) + append tail. *(inc 2/4; real smoke 187 ms vs 1.3 s)*
- [x] An agent that has gone through `/clear` (or `/resume`) shows prior-session history in the Activity view, stitched with a session boundary, on unambiguous cwd. *(inc 3b/4 — captured from now forward)*
- [x] Shared-cwd agents show an honest "stitching limited" notice, never misattributed history. *(inc 3b writer gap + panel `sharedCwd` notice)*
- [x] The log is normalized (no raw clone), carries provenance pointers, and copies rendered blobs; it survives a simulated runtime prune of the source file. *(inc 3a tests)*
- [x] Memory stays bounded on a multi-session feed (bounded recent window + `content-visibility` virtualization). **Re-scoped:** in-panel backward-paging-on-scroll is DEFERRED — the full history lives in the durable log + is reachable via Open-transcript; surfacing older pages in-panel on scroll-up (the reverse-infinite-scroll "painful path") is a future enhancement gated on demand, consistent with the spec-238 inc-6 deferral.
- [x] Concurrency/crash: two panels for one agent read the same log independently (no double-write — single writer); a restart mid-backfill recovers to a stable count via record-level idempotency. *(inc 3a/3b tests)*
- [x] "Open transcript" on a pruned source degrades to "source no longer on disk — rendered activity preserved", never a dead error. *(inc 4)*
