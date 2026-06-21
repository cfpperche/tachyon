import * as vscode from "vscode";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { Workspace } from "../workspace/Workspace.js";
import { createActivityBuilder, type ActivityBuilder, type ActivityViewModel } from "../activity/activityView.js";
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
type ActivityMsg = { type?: "ready" | "openFile" | "terminal" | "transcript" | "loadOlder"; path?: string };

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
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; stop: () => void }>();

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
      `◆ ${agent}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true },
    );
    const codiconUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "codicon.css"));
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "activity.js"));
    const mermaidUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "mermaid.js"));
    const katexUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "katex.js"));
    const katexCssUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "katex.min.css"));
    const codeTheme = vscode.workspace.getConfiguration("tachyon").get<string>("activity.codeTheme", "auto");
    panel.webview.html = html(panel.webview, { codiconUri, scriptUri, mermaidUri, katexUri, katexCssUri }, agent, codeTheme);

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
      const agentState = ws.attentionOf(agent)?.state;
      void panel.webview.postMessage({ type: "activity", vm: { ...vm, agentState, sharedCwd }, prepended });
    };
    // Images are big base64 blobs — post each ONCE on a side channel keyed by id (never re-sent in the
    // per-render view-model), so a long chat with screenshots never bloats the per-change payload.
    const postImage = (id: string, dataUri: string): void => void panel.webview.postMessage({ type: "imageData", id, dataUri });
    const { stop, replay, loadOlder } = this.watch(ws, agent, post, postImage);

    panel.webview.onDidReceiveMessage((m: ActivityMsg) => {
      if (m?.type === "ready") { replay(); return; } // a (re)loaded webview → re-push the VM + resend images
      if (m?.type === "openFile" && m.path && knownPaths.has(m.path)) {
        void vscode.window.showTextDocument(vscode.Uri.file(m.path), { preview: true, viewColumn: vscode.ViewColumn.Beside });
      } else if (m?.type === "transcript" && transcriptPath) {
        // The raw JSONL the runtime records the session into — opened read-only beside the cockpit. If the
        // runtime has since pruned it, degrade gracefully: the normalized activity is still preserved in our log.
        if (fs.existsSync(transcriptPath)) {
          void vscode.window.showTextDocument(vscode.Uri.file(transcriptPath), { preview: true, viewColumn: vscode.ViewColumn.Beside });
        } else {
          void vscode.window.showInformationMessage("Source transcript is no longer on disk — the rendered activity is preserved in Tachyon's durable log.");
        }
      } else if (m?.type === "terminal") {
        void vscode.commands.executeCommand("tachyon.openAgentTerminalItem", agent, ws.wsHash);
      } else if (m?.type === "loadOlder") {
        loadOlder(); // grow the rendered window backward (spec 239 inc 6)
      }
    });
    panel.onDidDispose(() => { stop(); this.panels.delete(key); });
    this.panels.set(key, { panel, stop });
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
      // Offer "load earlier" only below the cap — beyond it the header's "open transcript" reaches the rest.
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

function getNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

interface Uris { codiconUri: vscode.Uri; scriptUri: vscode.Uri; mermaidUri: vscode.Uri; katexUri: vscode.Uri; katexCssUri: vscode.Uri }
function html(webview: vscode.Webview, uris: Uris, agent: string, codeTheme: string): string {
  const { codiconUri, scriptUri, mermaidUri, katexUri, katexCssUri } = uris;
  const nonce = getNonce();
  const title = agent.replace(/[<>&]/g, "");
  const themeClass = codeTheme === "dark" ? "tac-theme-dark" : codeTheme === "light" ? "tac-theme-light" : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconUri}">
<title>${title}</title>
<style>
  :root {
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-widget-border, var(--vscode-editorWidget-border, rgba(128,128,128,.22)));
    --focus: var(--vscode-focusBorder);
    --ok: var(--vscode-testing-iconPassed, #4caf50);
    --err: var(--vscode-list-errorForeground, #f14c4c);
    --link: var(--vscode-textLink-foreground);
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0 0 24px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  button { font: inherit; color: inherit; background: none; border: none; padding: 0; cursor: pointer; }
  :focus-visible { outline: 1px solid var(--focus); outline-offset: 1px; border-radius: 3px; }

  /* Header: scan summary + the terminal escape hatch */
  .head { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 10px 16px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--border); }
  .head h1 { font-size: 14px; font-weight: 600; margin: 0; display: flex; align-items: center; gap: 7px; }
  .head .stat { color: var(--muted); font-size: 12px; display: inline-flex; align-items: center; gap: 4px; }
  .head .stat.err { color: var(--err); }
  .head .term { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 4px; }
  .head .term:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)); }
  .ver { font-size: 11px; color: var(--muted); opacity: .8; }
  .stale { font-size: 11px; color: var(--vscode-list-warningForeground, #cca700); }
  /* Recent-window search (filters the loaded/capped items only — the placeholder states the scope) */
  .head .search { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--vscode-input-background); }
  .head .search .codicon-search { font-size: 12px; color: var(--muted); }
  .head .search input { border: none; outline: none; background: none; color: var(--vscode-input-foreground); font: inherit; font-size: 12px; width: 150px; }
  .head .search .sclear { display: inline-flex; color: var(--muted); }
  .head .search .sclear:hover { color: var(--vscode-foreground); }

  /* Chat transcript: human bubbles right, agent bubbles left, activity chips threaded on the agent side */
  .feed { padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; max-width: 980px; margin: 0 auto; }
  /* Perf: older (offscreen) items skip layout/paint; the browser remembers their measured size (auto keyword).
     The live tail is NOT given this class (App.tsx) so bottom-stick height stays exact. */
  .feed > .cv { content-visibility: auto; contain-intrinsic-size: auto 60px; }
  /* Visible recent-window cap notice — replaces the silent drop of the oldest items */
  .capnote { align-self: center; display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); padding: 3px 12px; margin-bottom: 4px; border: 1px solid var(--border); border-radius: 12px; }
  .capnote:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)); }
  .capnote .codicon { font-size: 12px; }
  .msg { display: flex; }
  .msg.user { justify-content: flex-end; }
  .msg.agent { justify-content: flex-start; }
  .msg .bubble { max-width: 80%; padding: 8px 12px; border-radius: 14px; line-height: 1.45; }
  .msg .btext { overflow-wrap: anywhere; }
  .msg.user .btext { white-space: pre-wrap; }
  .msg .btime { font-size: 10px; opacity: .6; margin-top: 3px; text-align: right; }
  /* "working…" typing indicator (agent side) + a needs-input hint */
  .bubble.typing { display: inline-flex; gap: 4px; align-items: center; padding: 11px 14px; }
  .bubble.typing span { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: blink 1.2s infinite both; }
  .bubble.typing span:nth-child(2) { animation-delay: .2s; }
  .bubble.typing span:nth-child(3) { animation-delay: .4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }
  .needs { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--vscode-list-warningForeground, #cca700); padding: 2px 6px; }
  .needs .codicon { font-size: 12px; }
  .msg.user .bubble { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-bottom-right-radius: 4px; }
  .msg.agent .bubble { background: var(--vscode-editorWidget-background, var(--vscode-input-background)); color: var(--vscode-foreground); border: 1px solid var(--border); border-bottom-left-radius: 4px; position: relative; }
  /* preview ↔ raw markdown toggle (agent bubbles) */
  .rawtoggle { position: absolute; top: 4px; right: 4px; width: 20px; height: 20px; display: grid; place-items: center; border-radius: 4px; color: var(--muted); opacity: 0; transition: opacity .1s; }
  .msg.agent .bubble:hover .rawtoggle, .rawtoggle:focus-visible { opacity: 1; }
  .rawtoggle:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)); }
  .rawmd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; padding-right: 22px; max-height: 60vh; overflow: auto; }

  /* Markdown inside an agent bubble */
  .md p { margin: 0 0 6px; white-space: pre-wrap; }
  .md p:last-child { margin-bottom: 0; }
  .md .md-h { font-weight: 600; margin: 4px 0; }
  .md ul, .md ol { margin: 4px 0; padding-left: 20px; }
  .md li { margin: 1px 0; }
  .md code { font-family: var(--vscode-editor-font-family, monospace); font-size: .92em; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.18)); padding: 0 4px; border-radius: 3px; }
  .md pre { margin: 0; padding: 8px 10px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.14)); border-radius: 6px; overflow-x: auto; }
  .md pre code { background: none; padding: 0; }
  .md a { color: var(--link); }
  /* highlight.js theme — VS Code dark+ palette by default; light override under a light theme.
     The tachyon.activity.codeTheme setting can force a side via the body class (tac-theme-dark/light). */
  .hljs { color: var(--vscode-editor-foreground, #d4d4d4); }
  .hljs-comment, .hljs-quote { color: #6a9955; font-style: italic; }
  .hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-name, .hljs-tag { color: #569cd6; }
  .hljs-string, .hljs-attr, .hljs-regexp, .hljs-meta .hljs-string { color: #ce9178; }
  .hljs-number, .hljs-literal, .hljs-bullet { color: #b5cea8; }
  .hljs-title, .hljs-title.function_, .hljs-section { color: #dcdcaa; }
  .hljs-type, .hljs-title.class_, .hljs-class .hljs-title { color: #4ec9b0; }
  .hljs-attribute, .hljs-variable.language_ { color: #9cdcfe; }
  .hljs-symbol, .hljs-link, .hljs-meta, .hljs-keyword.module_ { color: #c586c0; }
  .hljs-deletion { color: var(--err); } .hljs-addition { color: var(--ok); }
  .hljs-emphasis { font-style: italic; } .hljs-strong { font-weight: 600; }
  /* Light context = auto-under-vscode-light OR forced-light; covers the SAME token set as dark (no half-themed) */
  :is(body.vscode-light:not(.tac-theme-dark), body.tac-theme-light) .hljs { color: var(--vscode-editor-foreground, #1e1e1e); }
  :is(body.vscode-light:not(.tac-theme-dark), body.tac-theme-light) :is(.hljs-comment, .hljs-quote) { color: #008000; }
  :is(body.vscode-light:not(.tac-theme-dark), body.tac-theme-light) :is(.hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-name, .hljs-tag) { color: #0000ff; }
  :is(body.vscode-light:not(.tac-theme-dark), body.tac-theme-light) :is(.hljs-string, .hljs-attr, .hljs-regexp, .hljs-meta .hljs-string) { color: #a31515; }
  :is(body.vscode-light:not(.tac-theme-dark), body.tac-theme-light) :is(.hljs-number, .hljs-literal, .hljs-bullet) { color: #098658; }
  :is(body.vscode-light:not(.tac-theme-dark), body.tac-theme-light) :is(.hljs-title, .hljs-title.function_, .hljs-section) { color: #795e26; }
  :is(body.vscode-light:not(.tac-theme-dark), body.tac-theme-light) :is(.hljs-type, .hljs-title.class_) { color: #267f99; }
  :is(body.vscode-light:not(.tac-theme-dark), body.tac-theme-light) :is(.hljs-attribute, .hljs-variable.language_) { color: #0451a5; }
  :is(body.vscode-light:not(.tac-theme-dark), body.tac-theme-light) :is(.hljs-symbol, .hljs-link, .hljs-meta, .hljs-keyword.module_) { color: #af00db; }
  /* Forced themes also pin the code-block background + base color so text never lands dark-on-dark */
  body.tac-theme-dark :is(.md pre, .cfull) { background: #1e1e1e; } body.tac-theme-dark .hljs { color: #d4d4d4; }
  body.tac-theme-light :is(.md pre, .cfull) { background: #f3f3f3; }
  /* markdown-it block elements */
  .md > :first-child { margin-top: 0; }
  .md > :last-child { margin-bottom: 0; }
  .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 8px 0 4px; font-weight: 600; line-height: 1.3; }
  .md h1 { font-size: 1.4em; } .md h2 { font-size: 1.25em; } .md h3 { font-size: 1.12em; } .md h4, .md h5, .md h6 { font-size: 1em; }
  .md blockquote { margin: 6px 0; padding: 2px 10px; border-left: 3px solid var(--border); color: var(--muted); }
  .md hr { border: 0; border-top: 1px solid var(--border); margin: 10px 0; }
  .md del { opacity: .7; }
  .md table { border-collapse: collapse; margin: 6px 0; display: block; overflow-x: auto; max-width: 100%; }
  .md th, .md td { border: 1px solid var(--border); padding: 4px 9px; text-align: left; }
  .md th { background: var(--vscode-editorWidget-background, rgba(128,128,128,.12)); font-weight: 600; }
  .md tr:nth-child(even) td { background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent); }
  .md ul.contains-task-list { list-style: none; padding-left: 18px; }
  .md .task-list-item { list-style: none; }
  .md .task-list-item input { margin: 0 6px 0 -18px; vertical-align: middle; }
  /* KaTeX math (lazy) */
  .tac-math[data-display="1"] { display: block; overflow-x: auto; text-align: center; margin: 6px 0; }
  .katex { font-size: 1.05em; }
  /* mermaid source (toggle) */
  .mmd-src { margin: 0; padding: 10px; overflow-x: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  /* fenced code block with a copy button */
  .codeblock { position: relative; margin: 6px 0; }
  .codeblock .copy { position: absolute; top: 5px; right: 5px; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 4px; color: var(--muted); background: var(--vscode-editorWidget-background, var(--vscode-input-background)); opacity: 0; transition: opacity .1s; }
  .codeblock:hover .copy, .codeblock .copy:focus-visible { opacity: 1; }
  .codeblock .copy:hover { color: var(--vscode-foreground); }
  .codeblock .copy.fail { opacity: 1; color: var(--err); }
  /* long-message clamp + fade + toggle */
  .btext.clamp { max-height: 17em; overflow: hidden; -webkit-mask-image: linear-gradient(to bottom, #000 72%, transparent); mask-image: linear-gradient(to bottom, #000 72%, transparent); }
  .more { margin-top: 4px; font-size: 11px; color: var(--link); }
  .more:hover { text-decoration: underline; }
  .msg.user .md a { color: var(--vscode-button-foreground); text-decoration: underline; }
  .msg.user .md code { background: rgba(255,255,255,.2); }

  /* Day separator */
  .daysep { text-align: center; margin: 8px 0 2px; }
  .daysep span { font-size: 10px; color: var(--muted); background: var(--vscode-editorWidget-background, var(--vscode-input-background)); border: 1px solid var(--border); border-radius: 10px; padding: 1px 10px; }

  /* Compaction boundary — a full-width "context compacted" rule (history before it is retained) */
  .boundary { display: flex; align-items: center; gap: 8px; margin: 10px 2px; color: var(--muted); font-size: 11px; }
  .boundary::before, .boundary::after { content: ""; flex: 1; height: 1px; background: var(--border); }
  .boundary .codicon { font-size: 12px; opacity: .8; }
  .boundary .bmeta { opacity: .7; font-variant-numeric: tabular-nums; }
  .boundary .bsum { color: var(--link); font-size: 11px; }
  .boundary .bsum:hover { text-decoration: underline; }
  .boundary-summary { margin: 2px 12px 8px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--vscode-editorWidget-background, var(--vscode-input-background)); color: var(--muted); font-size: 12px; max-height: 40vh; overflow: auto; }

  /* Slash-command marker — a subtle centered line (the human ran a command; not a chat bubble) */
  .cmdline { align-self: center; display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); opacity: .85; margin: 2px 0; }
  .cmdline .codicon { font-size: 12px; }

  /* Thinking — collapsible reasoning on the agent side */
  .think { align-self: flex-start; max-width: 82%; }
  .think-toggle { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted); font-style: italic; max-width: 100%; }
  .think-toggle:hover { color: var(--vscode-foreground); }
  .think-toggle .codicon { font-size: 12px; flex: none; }
  .think-prev { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .think-body { margin: 4px 0 2px 18px; padding: 6px 10px; border-left: 2px solid var(--border); color: var(--muted); font-size: 12px; }

  /* Image bubble */
  .bubble.img { padding: 4px; }
  .bubble.img img { max-width: min(340px, 100%); max-height: 340px; border-radius: 8px; display: block; cursor: zoom-in; }
  .img-ph { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; padding: 14px 22px; }

  /* Activity chips (tool / file / error) — compact, muted, left-aligned (the agent's side) */
  .chip-wrap { align-self: flex-start; max-width: 92%; min-width: 0; }
  .chip-wrap.err .cname, .chip-wrap.err .chip > .codicon { color: var(--err); }
  .chip { display: flex; align-items: baseline; gap: 6px; padding: 0 0 0 6px; font-size: 11px; color: var(--muted); }
  .chip .codicon { font-size: 12px; flex: none; align-self: center; }
  .chip .cname { font-weight: 600; flex: none; }
  .chip .ct, .chip .flink { font-family: var(--vscode-editor-font-family, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .chip .flink { color: var(--link); text-decoration: none; }
  .chip .flink:hover { text-decoration: underline; }
  .chip .cres { opacity: .75; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip .cexp { color: var(--muted); display: inline-flex; flex: none; }
  .chip .cexp:hover { color: var(--vscode-foreground); }
  .chip .codicon-loading { animation: spin 1.1s linear infinite; }
  .cfull { margin: 3px 0 4px 18px; padding: 8px 10px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.14)); border-radius: 6px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.4; white-space: pre-wrap; overflow: auto; max-height: 340px; }

  /* mermaid diagram (rendered on demand), with an always-visible diagram↔source toggle bar */
  .mmd { margin: 6px 0; background: var(--vscode-editorWidget-background, var(--vscode-input-background)); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .mmd-bar { display: flex; align-items: center; gap: 8px; padding: 4px 10px; border-bottom: 1px solid var(--border); font-size: 11px; color: var(--muted); }
  .mmd-label { display: inline-flex; align-items: center; gap: 5px; }
  .mmd-label .codicon, .mmd-toggle .codicon { font-size: 12px; }
  .mmd-toggle { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; color: var(--link); }
  .mmd-toggle:hover { text-decoration: underline; }
  .mmd-svg { padding: 10px; overflow-x: auto; }
  .mmd-svg svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
  .mmd-loading { padding: 12px; display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
  .mmd-loading .codicon-loading { animation: spin 1.1s linear infinite; }

  /* Jump-to-latest */
  .jump { position: fixed; right: 18px; bottom: 18px; display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); box-shadow: 0 2px 10px rgba(0,0,0,.4); z-index: 5; }
  .jump:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  @keyframes spin { to { transform: rotate(360deg); } }

  .degrade { padding: 48px 24px; text-align: center; color: var(--muted); }
  .degrade .codicon { font-size: 28px; opacity: .5; display: block; margin: 0 auto 10px; }
  .degrade .term { display: inline-flex; align-items: center; gap: 6px; margin-top: 14px; padding: 5px 12px; border-radius: 4px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

  /* Image lightbox — full-size overlay (click-out or Escape closes) */
  .lightbox { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 32px; background: rgba(0,0,0,.72); cursor: zoom-out; }
  .lightbox img { max-width: 100%; max-height: 100%; border-radius: 6px; box-shadow: 0 6px 30px rgba(0,0,0,.5); cursor: default; }
  .lb-close { position: fixed; top: 14px; right: 16px; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 6px; color: #fff; background: rgba(255,255,255,.14); }
  .lb-close:hover { background: rgba(255,255,255,.28); }

  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>
</head>
<body class="${themeClass}">
  <div id="root"></div>
  <script nonce="${nonce}">window.__mermaidSrc=${JSON.stringify(mermaidUri.toString())};window.__katexSrc=${JSON.stringify(katexUri.toString())};window.__katexCssUri=${JSON.stringify(katexCssUri.toString())};window.__codeThemeForced=${JSON.stringify(codeTheme)};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
