/**
 * t-610705 (SDD 410 Phase C.2) — the Activity feed's watcher, ported from the retired
 * ActivityPanelManager's private `watch()` method (mirrors the boardVm.ts/taskDetailVm.ts
 * pure-extraction precedent from Phases B/C.1). This module still touches `fs` (the durable
 * per-agent log tail/watch is inherently I/O), so it isn't "pure" the way those two are — but it
 * stays vscode-free and independently testable.
 *
 * Hardening-dueto finding (probe-2d90286d): Control hosts AT MOST ONE active feed at a time (unlike
 * the standalone panel, which kept one independent watcher PER OPEN PANEL in a Map — agents never
 * shared a slot). Collapsing to one shared slot means a late async continuation from a TORN-DOWN
 * feed could otherwise post into whatever feed replaced it. Every callback and continuation here
 * checks `io.isCurrent()` — owned by the caller (Cockpit.ts), backed by a binding-generation counter
 * — immediately before touching `io.post`/`io.postImage`. `stop()` is the synchronous, ordinary path
 * (fs.unwatchFile/clearInterval — Node never re-fires after these), `isCurrent()` is the defense for
 * work already in flight (in practice only the one genuine promise continuation below).
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { WorkspaceActivityTarget } from "../../shell/ActivityTarget.js";
import { createActivityBuilder, type ActivityBuilder, type ActivityViewModel } from "../../activity/activityView.js";
import { ActivityLog, type LoggedEvent } from "@tachyon/engine/activity/logStore.js";
import type { NormalizedEvent } from "@tachyon/engine/activity/types.js";

const MAX_ITEMS = 600;
const MAX_TAIL_RECORDS = 4000;
const ALLOWED_IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const PAGE_ITEMS = 600;
const PAGE_RECORDS = 4000;
const MAX_SHOWN_ITEMS = 5000;
const MAX_WINDOW_RECORDS = 40000;

export interface ActivityFeedIO {
  /** vm is already agentState/sharedCwd-enriched; the caller adds wire identity + does postMessage. */
  post: (vm: ActivityViewModel, prepended: boolean) => void;
  postImage: (id: string, dataUri: string) => void;
  /** True while this feed instance is still the one Cockpit wants on screen — checked before every
   *  observable action (post/postImage). Backed by the caller's binding-generation counter. */
  isCurrent: () => boolean;
  /**
   * SDD 485 B1 — true while the host surface is HIDDEN behind another editor tab. The feed then does
   * no read, no build and no post; the durable log keeps growing and the byte offset stays where it
   * was, so `catchUp()` on reveal is a delta from the log itself (and a full re-prime when the log
   * was truncated under us — `pump()`'s `size < offset` branch). Absent = never paused.
   */
  paused?: () => boolean;
}

export interface ActivityFeed {
  stop: () => void;
  /**
   * SDD 485 B2 — reveal catch-up: ingest whatever the log grew while the surface was hidden and
   * re-render once, instead of the per-change renders that were suppressed. A no-op when nothing
   * changed — the retained webview is already showing the right thing.
   */
  catchUp: () => void;
  /** Re-flush every retained image + repost the current VM. For cockpit READY / webview-reload
   *  recovery (the client's in-memory image cache is presumed empty) — NOT for the shared 3s shell
   *  poll, which must never touch an agent-activity route at all (see route.ts's refreshPolicy doc). */
  replayImages: () => void;
  loadOlder: () => void;
}

export function startActivityFeed(ws: WorkspaceActivityTarget, agent: string, io: ActivityFeedIO): ActivityFeed {
  const dir = nodePath.join(ws.workspaceRoot, ".tachyon", "activity");
  const log = new ActivityLog(dir, agent);
  const logFile = log.file;
  let builder: ActivityBuilder = createActivityBuilder();
  let imageEvents: LoggedEvent[] = [];
  let seen = 0;
  let started = false;
  let offset = 0;
  let partial: Buffer = Buffer.alloc(0);
  let seq = 0;
  let windowRecords = MAX_TAIL_RECORDS;
  let shownItems = MAX_ITEMS;
  let windowHasOlder = false;
  const sentImages = new Set<string>();
  let sharedCwd = false;
  const resetState = (): void => { builder = createActivityBuilder(); imageEvents = []; seen = 0; offset = 0; partial = Buffer.alloc(0); seq = 0; sentImages.clear(); started = false; };

  const toNormalized = (e: LoggedEvent): NormalizedEvent => ({
    type: e.type as NormalizedEvent["type"], runtime: (e.source?.runtime ?? "claude") as NormalizedEvent["runtime"],
    sequence: seq++, sessionId: e.sessionId, cwd: e.cwd, timestamp: e.timestamp, runtimeVersion: e.runtimeVersion,
    model: e.model, effort: e.effort,
    recordId: e.source?.recordId, sourcePath: e.source?.sourcePath, payload: e.payload as NormalizedEvent["payload"], raw: undefined,
  });

  const render = (prepended = false): void => {
    if (!io.isCurrent()) return;
    const full = builder.view({ tier: "structured" });
    const items = full.items.length > shownItems ? full.items.slice(-shownItems) : full.items;
    const hasOlder = shownItems < MAX_SHOWN_ITEMS && (full.items.length > items.length || windowHasOlder);
    const rawState = ws.activityAttention(agent);
    const agentState = rawState === "throttled" ? undefined : rawState;
    io.post({ ...full, items, totalItems: full.items.length, hasOlder, agentState, sharedCwd }, prepended);
  };

  const flushImages = (list: LoggedEvent[]): void => {
    if (!io.isCurrent()) return;
    for (const e of list) {
      if (e.type !== "image.attached" || !e.blobRef) continue;
      const id = (e.payload as { id?: string }).id;
      if (!id || sentImages.has(id)) continue;
      let data: Buffer;
      try { data = fs.readFileSync(log.blobPath(e.blobRef)); } catch { continue; }
      const mt = (e.payload as { mediaType?: string }).mediaType;
      const media = ALLOWED_IMAGE.has(mt ?? "") ? mt! : "image/png";
      sentImages.add(id);
      io.postImage(id, `data:${media};base64,${data.toString("base64")}`);
    }
  };
  const replayImages = (): void => { sentImages.clear(); flushImages(imageEvents); render(); };

  const ingest = (events: LoggedEvent[]): boolean => {
    if (events.length) {
      builder.push(events.map(toNormalized));
      seen += events.length;
      for (const e of events) if (e.type === "image.attached") imageEvents.push(e);
      flushImages(events);
    }
    return seen > 0;
  };

  const prime = (): boolean => {
    resetState();
    if (log.size() === 0) return false;
    const t = log.tailFrom(windowRecords);
    if (t.offset === 0 && t.events.length === 0) return false;
    offset = t.offset; partial = t.partial; windowHasOlder = t.startOffset > 0;
    started = true;
    return ingest(t.events);
  };

  const pump = (): boolean => {
    if (!started) return prime();
    const size = log.size();
    if (size < offset) { resetState(); return pump(); }
    if (size === offset) return false;
    const f = log.forwardFrom(offset, partial);
    offset = f.offset; partial = f.partial;
    return ingest(f.events);
  };

  const loadOlder = (): void => {
    if (!io.isCurrent()) return;
    shownItems = Math.min(shownItems + PAGE_ITEMS, MAX_SHOWN_ITEMS);
    const have = builder.view({ tier: "structured" }).items.length;
    if (shownItems > have && windowHasOlder && windowRecords < MAX_WINDOW_RECORDS) {
      windowRecords = Math.min(windowRecords + PAGE_RECORDS, MAX_WINDOW_RECORDS);
      prime();
    }
    render(true);
  };

  let missedWhilePaused = false;
  let lastState: string | undefined;

  const onChange = (cur: fs.Stats, prev: fs.Stats): void => {
    if (!io.isCurrent()) return;
    if (started && cur.mtimeMs === prev.mtimeMs) return;
    // SDD 485 B1 — hidden: record that the log moved and read NOTHING. The offset is the journal
    // cursor; catchUp() below is the trailing edge that makes this safe rather than merely cheap.
    if (io.paused?.()) { missedWhilePaused = true; return; }
    try { if (pump()) render(); } catch { /* transient read race — the next tick catches up */ }
  };
  fs.watchFile(logFile, { interval: 500 }, onChange);

  try { if (pump()) render(); } catch { /* the file may not exist yet — watchFile will catch its creation */ }

  // sharedCwd resolves asynchronously (may consult the ownership ledger) — the ONE genuine promise
  // continuation in this module, so it's the one place a stale post could otherwise slip through.
  void ws.activityContext(agent).then((context) => {
    if (!io.isCurrent()) return;
    sharedCwd = context.sharedCwd;
    render();
  }).catch(() => undefined);

  const stateTimer = setInterval(() => {
    if (!io.isCurrent()) return;
    // Hidden: not even the attention read. catchUp() re-reads it once on reveal.
    if (io.paused?.()) return;
    const st = ws.activityAttention(agent);
    if (st !== lastState) { lastState = st; render(); }
  }, 1000);

  const catchUp = (): void => {
    if (!io.isCurrent()) return;
    let changed = false;
    if (missedWhilePaused) {
      missedWhilePaused = false;
      try { changed = pump(); } catch { /* transient read race — the next tick catches up */ }
    }
    const st = ws.activityAttention(agent);
    if (st !== lastState) { lastState = st; changed = true; }
    if (changed) render();
  };

  return {
    stop: () => { clearInterval(stateTimer); fs.unwatchFile(logFile, onChange); },
    catchUp,
    replayImages,
    loadOlder,
  };
}
