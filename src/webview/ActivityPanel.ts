import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { Workspace } from "../workspace/Workspace.js";
import { createActivityBuilder, type ActivityBuilder, type ActivityViewModel } from "../activity/activityView.js";
import { activityMessage, imageDataMessage } from "./activity/messages.js";
import { renderWebviewShell } from "./shared/shell.js";
import { ActivityLog, type LoggedEvent } from "../activity/logStore.js";
import { isResumable } from "../resume/SessionLedger.js";
import type { NormalizedEvent } from "../activity/types.js";

/** Cap the feed posted to the webview so payloads stay bounded on a long session (only the rendered tail). */
const MAX_ITEMS = 600;

/** Bound the INITIAL read to the last N log records (spec 239 inc 4 reads the durable log, not the runtime). */
const MAX_TAIL_RECORDS = 4000;

/** Raster image types we'll build a data: URI for — SVG is excluded (it can carry script). */
const ALLOWED_IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Messages the activity webview posts to the host. */
type ActivityMsg = { type?: "ready" | "openFile" | "terminal" | "loadOlder"; path?: string };

/** Backward-paging page sizes (spec 239 inc 6): each "load earlier" grows the shown items by PAGE_ITEMS and,
 *  when that outruns the in-memory window, re-reads PAGE_RECORDS more log records — up to a hard cap, beyond
 *  which the view stops offering "load earlier" and points to the full transcript (bounds the postMessage). */
const PAGE_ITEMS = 600;
const PAGE_RECORDS = 4000;
const MAX_SHOWN_ITEMS = 5000;
const MAX_WINDOW_RECORDS = 40000;

/**
 * spec 238 — the Runtime Activity View. An editor-area WebviewPanel (one per agent) that renders a
 * normalized, runtime-agnostic "activity cockpit": assistant messages, collapsed tool calls, clickable
 * file links, usage. The RAW runtime terminal stays one click away (the escape hatch). Read-only in v1.
 *
 * Data layer: the agent's on-disk transcript (located via `manager.transcriptPathOf`, reusing the resume
 * adapters) → `normalizeClaude` → `buildActivityView`. Perf: the transcript PATH is resolved once on open
 * and re-resolved on a slow cadence (a project-dir scan — never per content-change, the spec-221 leak
 * class); CONTENT freshness is an `fs.watchFile` mtime poll (stat-only) that re-reads on change.
 */
export class ActivityPanelManager {
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; stop: () => void; openTranscript: () => void }>();
  /** the key of the most-recently-active activity panel — target of the palette "Open Raw Transcript" command */
  private activeKey?: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getWorkspaces: () => Workspace[],
  ) {}

  open(agent: string, wsHash?: string): void {
    const ws = wsHash === undefined ? this.getWorkspaces()[0] : this.getWorkspaces().find((w) => w.wsHash === wsHash);
    if (!ws) return;
    const key = `${ws.wsHash}::${agent}`;
    const existing = this.panels.get(key);
    if (existing) { existing.panel.reveal(vscode.ViewColumn.Active); return; }

    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const panel = vscode.window.createWebviewPanel(
      "tachyonActivity",
      agent,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true },
    );
    panel.iconPath = panelIcon(this.extensionUri, "pulse"); // spec 282 — contextual editor-tab icon
    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    const codeTheme = vscode.workspace.getConfiguration("tachyon").get<string>("activity.codeTheme", "auto");
    const themeClass = codeTheme === "dark" ? "tac-theme-dark" : codeTheme === "light" ? "tac-theme-light" : "";
    // spec 280 — the on-demand mermaid/katex URLs + the code-theme reach the bundle via the shell's nonce'd
    // bootstrap globals (JSON-encoded; the bundle injects mermaid/katex only when a math/diagram block appears).
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title: agent.replace(/[<>&]/g, ""),
      styles: [uri("codicon.css"), uri("design-system.css"), uri("activity.css")],
      bundle: uri("activity.js"),
      mode: "live",
      bodyClass: themeClass || undefined,
      bootstrapGlobals: {
        __mermaidSrc: uri("mermaid.js"),
        __katexSrc: uri("katex.js"),
        __katexCssUri: uri("katex.min.css"),
        __codeThemeForced: codeTheme,
      },
    });

    // The set of file paths the host has actually surfaced — openFile is restricted to these (the webview
    // can't ask the host to open an arbitrary path).
    let knownPaths = new Set<string>();
    let transcriptPath: string | undefined; // the host's own resolved transcript path (not webview-supplied)
    // ≥2 resumable agents in this agent's cwd → the writer can't safely stitch sessions there (prefer-gap);
    // surface an honest notice. Computed once on open (cwd-sharing rarely changes during a panel's life).
    const sharedCwd = sharesCwd(ws, agent);
    const post = (vm: ActivityViewModel, prepended?: boolean): void => {
      knownPaths = new Set([...vm.summary.filesChanged, ...vm.summary.filesReferenced]);
      transcriptPath = vm.sourcePath;
      // `vm.items` is already sliced to the shown window by the watcher's render() (backward paging grows it);
      // Live work state from the AttentionMonitor (same signal as the sidebar "working" pill). `prepended` (one-shot)
      // tells the webview THIS specific VM grew older items at the top → keep the scroll anchored (not a live append).
      // spec 306 — "throttled" has no Activity-view equivalent yet (neither "typing" nor "needs your input" is
      // true); the sidebar dot/badge/toast already cover visibility, so this narrower live-state hint just omits
      // it rather than misrepresenting it or growing AgentActivityState for a surface this spec doesn't touch.
      const rawState = ws.attentionOf(agent)?.state;
      const agentState = rawState === "throttled" ? undefined : rawState;
      // spec 278 — POST via the shared envelope (the dev preview harness uses the same constructor).
      void panel.webview.postMessage(activityMessage({ ...vm, agentState, sharedCwd }, prepended));
    };
    // Images are big base64 blobs — post each ONCE on a side channel keyed by id (never re-sent in the
    // per-render view-model), so a long chat with screenshots never bloats the per-change payload.
    const postImage = (id: string, dataUri: string): void => void panel.webview.postMessage(imageDataMessage(id, dataUri));
    const { stop, replay, loadOlder } = this.watch(ws, agent, post, postImage);

    // The raw JSONL the runtime records the session into — opened read-only beside the cockpit (a power-user /
    // debug escape hatch, demoted from a header button to the `Tachyon: Open Raw Transcript` palette command in
    // 0.29.1; the rendered durable log is the primary surface). Degrades gracefully if the runtime pruned it.
    const openTranscript = (): void => {
      if (transcriptPath && fs.existsSync(transcriptPath)) {
        void vscode.window.showTextDocument(vscode.Uri.file(transcriptPath), { preview: true, viewColumn: vscode.ViewColumn.Beside });
      } else {
        void vscode.window.showInformationMessage("Source transcript is no longer on disk — the rendered activity is preserved in Tachyon's durable log.");
      }
    };

    panel.webview.onDidReceiveMessage((m: ActivityMsg) => {
      if (m?.type === "ready") { replay(); return; } // a (re)loaded webview → re-push the VM + resend images
      if (m?.type === "openFile" && m.path && knownPaths.has(m.path)) {
        void vscode.window.showTextDocument(vscode.Uri.file(m.path), { preview: true, viewColumn: vscode.ViewColumn.Beside });
      } else if (m?.type === "terminal") {
        void vscode.commands.executeCommand("tachyon.openAgentTerminalItem", agent, ws.wsHash);
      } else if (m?.type === "loadOlder") {
        loadOlder(); // grow the rendered window backward (spec 239 inc 6)
      }
    });
    this.activeKey = key;
    panel.onDidChangeViewState((e) => { if (e.webviewPanel.active) this.activeKey = key; });
    panel.onDidDispose(() => {
      stop();
      this.panels.delete(key);
      // Closing the active panel: VS Code may not re-emit an active event for a still-visible sibling, so pick a
      // live fallback (active → visible → any) rather than stranding a valid panel behind the "open one first" notice.
      if (this.activeKey === key) {
        this.activeKey = undefined;
        for (const [k, e] of this.panels) { if (e.panel.active || e.panel.visible) { this.activeKey = k; break; } }
        if (!this.activeKey) this.activeKey = [...this.panels.keys()].pop();
      }
    });
    this.panels.set(key, { panel, stop, openTranscript });
  }

  /** Open the raw runtime transcript for the most-recently-active Activity panel (palette command). */
  openTranscriptForActive(): void {
    const entry = this.activeKey ? this.panels.get(this.activeKey) : undefined;
    if (!entry) {
      void vscode.window.showInformationMessage("Open an agent's Activity view first, then run “Open Raw Transcript”.");
      return;
    }
    entry.openTranscript();
  }

  /**
   * spec 239 inc 4 — render from the DURABLE per-agent log (`.tachyon/activity/<agent>.jsonl`), NOT the runtime
   * transcript. The always-on ActivityLogManager writer owns runtime tailing + session resolution + stitching;
   * the panel is a pure read-only subscriber: bounded initial read (last N log records) + forward tail of the
   * log as the writer appends (offset + raw-byte partial — the same inc-2 seam, now on the log). Multi-session
   * stitch is automatic (the log already spans sessions); `session.boundary` records render as separators.
   */
  private watch(ws: Workspace, agent: string, post: (vm: ActivityViewModel, prepended?: boolean) => void, postImage: (id: string, dataUri: string) => void): { stop: () => void; replay: () => void; loadOlder: () => void } {
    let disposed = false;
    const dir = nodePath.join(ws.workspaceRoot, ".tachyon", "activity");
    const log = new ActivityLog(dir, agent);
    const logFile = log.file;
    let builder: ActivityBuilder = createActivityBuilder();
    let imageEvents: LoggedEvent[] = []; // image events retained for replay (blob loaded on demand)
    let seen = 0;
    let started = false; // have we done the bounded initial read yet (once the log exists)?
    let offset = 0;
    let partial: Buffer = Buffer.alloc(0);
    let seq = 0; // synthesize a monotonic sequence for the builder (the log's order IS the sequence)
    let windowRecords = MAX_TAIL_RECORDS; // grows on "load earlier" (backward paging)
    let shownItems = MAX_ITEMS; // how many of the window's items to post (grows on "load earlier")
    let windowHasOlder = false; // does the on-disk log have records before the loaded window?
    const sentImages = new Set<string>();
    const resetState = (): void => { builder = createActivityBuilder(); imageEvents = []; seen = 0; offset = 0; partial = Buffer.alloc(0); seq = 0; sentImages.clear(); started = false; };

    const toNormalized = (e: LoggedEvent): NormalizedEvent => ({
      type: e.type as NormalizedEvent["type"], runtime: (e.source?.runtime ?? "claude") as NormalizedEvent["runtime"],
      sequence: seq++, sessionId: e.sessionId, cwd: e.cwd, timestamp: e.timestamp, runtimeVersion: e.runtimeVersion,
      recordId: e.source?.recordId, sourcePath: e.source?.sourcePath, payload: e.payload as NormalizedEvent["payload"], raw: undefined,
    });

    const render = (prepended = false): void => {
      const full = builder.view({ tier: "structured" });
      const items = full.items.length > shownItems ? full.items.slice(-shownItems) : full.items;
      // Offer "load earlier" only below the cap — beyond it the "Open Raw Transcript" command reaches the rest.
      const hasOlder = shownItems < MAX_SHOWN_ITEMS && (full.items.length > items.length || windowHasOlder);
      post({ ...full, items, totalItems: full.items.length, hasOlder }, prepended);
    };

    /** Post the bytes of any image we haven't sent yet — loaded from the log's content-addressed blob store. */
    const flushImages = (list: LoggedEvent[]): void => {
      for (const e of list) {
        if (e.type !== "image.attached" || !e.blobRef) continue;
        const id = (e.payload as { id?: string }).id;
        if (!id || sentImages.has(id)) continue;
        let data: Buffer;
        try { data = fs.readFileSync(log.blobPath(e.blobRef)); } catch { continue; }
        const mt = (e.payload as { mediaType?: string }).mediaType;
        const media = ALLOWED_IMAGE.has(mt ?? "") ? mt! : "image/png";
        sentImages.add(id);
        postImage(id, `data:${media};base64,${data.toString("base64")}`);
      }
    };
    const replay = (): void => { sentImages.clear(); flushImages(imageEvents); render(); };

    const ingest = (events: LoggedEvent[]): boolean => {
      if (events.length) {
        builder.push(events.map(toNormalized));
        seen += events.length;
        for (const e of events) if (e.type === "image.attached") imageEvents.push(e);
        flushImages(events);
      }
      return seen > 0;
    };

    /** (Re)build the rendered window from the last `windowRecords` log records — bounded; tracks whether older
     *  records remain on disk. Used for the initial read AND for growing the window backward (load earlier). */
    const prime = (): boolean => {
      resetState();
      if (log.size() === 0) return false; // no log yet → keep the "waiting for activity" empty state
      const t = log.tailFrom(windowRecords);
      if (t.offset === 0 && t.events.length === 0) return false; // read failed despite size>0 → stay un-started, retry
      offset = t.offset; partial = t.partial; windowHasOlder = t.startOffset > 0;
      started = true; // only NOW — a failed initial read must not flip us to forward-from-0
      return ingest(t.events);
    };

    /** Catch up to the log: bounded initial read once it exists, then forward-tail new appends. */
    const pump = (): boolean => {
      if (!started) return prime();
      const size = log.size();
      if (size < offset) { resetState(); return pump(); } // log replaced/rotated (shouldn't happen) → re-read
      if (size === offset) return false;
      const f = log.forwardFrom(offset, partial);
      offset = f.offset; partial = f.partial;
      return ingest(f.events);
    };

    /** Grow the rendered window backward (the webview's "load earlier" control). Shows more of the in-memory
     *  window; re-reads a bigger window from disk only when the shown count outruns it AND older records exist. */
    const loadOlder = (): void => {
      shownItems = Math.min(shownItems + PAGE_ITEMS, MAX_SHOWN_ITEMS);
      const have = builder.view({ tier: "structured" }).items.length;
      if (shownItems > have && windowHasOlder && windowRecords < MAX_WINDOW_RECORDS) {
        windowRecords = Math.min(windowRecords + PAGE_RECORDS, MAX_WINDOW_RECORDS);
        prime();
      }
      render(true); // mark this VM as a prepend so the webview keeps the scroll anchored (codex MAJOR)
    };

    const onChange = (cur: fs.Stats, prev: fs.Stats): void => {
      if (disposed) return;
      if (started && cur.mtimeMs === prev.mtimeMs) return; // watchFile poll tick with no real change
      try { if (pump()) render(); } catch { /* transient read race — the next tick catches up */ }
    };
    // watchFile fires even before the file exists (when the writer first creates it). Poll the log mtime.
    fs.watchFile(logFile, { interval: 500 }, onChange);

    try { if (pump()) render(); } catch { /* the file may not exist yet — watchFile will catch its creation */ }

    // Work state changes WITHOUT a log change (silent generation) → poll it cheaply and re-post on a transition.
    let lastState: string | undefined;
    const stateTimer = setInterval(() => {
      if (disposed) return;
      const st = ws.attentionOf(agent)?.state;
      if (st !== lastState) { lastState = st; render(); }
    }, 1000);
    return { stop: () => { disposed = true; clearInterval(stateTimer); fs.unwatchFile(logFile, onChange); }, replay, loadOlder };
  }

  dispose(): void {
    for (const { panel } of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}

/** True when another resumable agent shares this agent's cwd — session stitching is suppressed there. */
function sharesCwd(ws: Workspace, agent: string): boolean {
  const mine = ws.ledger.get(agent);
  if (!mine || !isResumable(mine)) return false; // only for resumable agents
  if (mine.resume?.sessionId) return false; // a captured uuid or unique title → attributable even on a shared cwd
  const myCwd = nodePath.resolve(mine.cwd);
  for (const [name, rec] of ws.ledger.all()) {
    if (name !== agent && isResumable(rec) && nodePath.resolve(rec.cwd) === myCwd) return true;
  }
  return false;
}
