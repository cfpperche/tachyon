import * as vscode from "vscode";
import * as fs from "node:fs";
import type { Workspace } from "../workspace/Workspace.js";
import { createClaudeNormalizer, type ClaudeNormalizer } from "../activity/claudeNormalizer.js";
import { buildActivityView, type ActivityViewModel } from "../activity/activityView.js";
import type { NormalizedEvent } from "../activity/types.js";

/** Cap the feed posted to the webview so payloads stay bounded on a long session (the summary stays
 *  cumulative; only the rendered tail is trimmed). */
const MAX_ITEMS = 600;

/** Raster image types we'll build a data: URI for — SVG is excluded (it can carry script). */
const ALLOWED_IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Messages the activity webview posts to the host. */
type ActivityMsg = { type?: "ready" | "openFile" | "terminal" | "transcript"; path?: string };

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
    panel.webview.html = html(panel.webview, codiconUri, scriptUri, agent);

    // The set of file paths the host has actually surfaced — openFile is restricted to these (the webview
    // can't ask the host to open an arbitrary path).
    let knownPaths = new Set<string>();
    let transcriptPath: string | undefined; // the host's own resolved transcript path (not webview-supplied)
    const post = (vm: ActivityViewModel): void => {
      knownPaths = new Set([...vm.summary.filesChanged, ...vm.summary.filesReferenced]);
      transcriptPath = vm.sourcePath;
      const items = vm.items.length > MAX_ITEMS ? vm.items.slice(-MAX_ITEMS) : vm.items;
      void panel.webview.postMessage({ type: "activity", vm: { ...vm, items } });
    };
    // Images are big base64 blobs — post each ONCE on a side channel keyed by id (never re-sent in the
    // per-render view-model), so a long chat with screenshots never bloats the per-change payload.
    const postImage = (id: string, dataUri: string): void => void panel.webview.postMessage({ type: "imageData", id, dataUri });
    const { stop, replay } = this.watch(ws, agent, post, postImage);

    panel.webview.onDidReceiveMessage((m: ActivityMsg) => {
      if (m?.type === "ready") { replay(); return; } // a (re)loaded webview → re-push the VM + resend images
      if (m?.type === "openFile" && m.path && knownPaths.has(m.path)) {
        void vscode.window.showTextDocument(vscode.Uri.file(m.path), { preview: true, viewColumn: vscode.ViewColumn.Beside });
      } else if (m?.type === "transcript" && transcriptPath) {
        // The raw JSONL the runtime records the session into — opened read-only beside the cockpit.
        void vscode.window.showTextDocument(vscode.Uri.file(transcriptPath), { preview: true, viewColumn: vscode.ViewColumn.Beside });
      } else if (m?.type === "terminal") {
        void vscode.commands.executeCommand("tachyon.openAgentTerminalItem", agent, ws.wsHash);
      }
    });
    panel.onDidDispose(() => { stop(); this.panels.delete(key); });
    this.panels.set(key, { panel, stop });
  }

  /**
   * Tail the agent's transcript: resolve the path, INCREMENTALLY read only appended bytes (offset +
   * partial-line buffer) through a stateful normalizer, accumulate events, and post on every content
   * change. The path is re-resolved on a slow cadence to follow an in-TUI /resume session switch (the only
   * disk-SCAN path — the per-change read is byte-bounded + stat-gated, avoiding the spec-221 leak class).
   */
  private watch(ws: Workspace, agent: string, post: (vm: ActivityViewModel) => void, postImage: (id: string, dataUri: string) => void): { stop: () => void; replay: () => void } {
    let watched: string | undefined;
    let disposed = false;
    let gen = 0; // bumped on every (re)point so an in-flight async resolve can't write into a stale watch
    let norm: ClaudeNormalizer = createClaudeNormalizer();
    let events: NormalizedEvent[] = [];
    let offset = 0;
    let partial = "";
    const sentImages = new Set<string>();

    const render = (): void => post(buildActivityView(events, { tier: "structured" }));

    /** Post the base64 data for any image we haven't sent yet (once per id). */
    const flushImages = (fresh: NormalizedEvent[]): void => {
      for (const ev of fresh) {
        if (ev.type !== "image.attached") continue;
        const id = (ev.payload as { id?: string }).id;
        if (!id || sentImages.has(id)) continue;
        const src = (ev.raw as { source?: { media_type?: string; data?: string } } | undefined)?.source;
        if (typeof src?.data !== "string") continue;
        const media = ALLOWED_IMAGE.has(src.media_type ?? "") ? src.media_type! : "image/png"; // raster only, no svg
        sentImages.add(id);
        postImage(id, `data:${media};base64,${src.data}`);
      }
    };
    /** Re-push the current VM + resend every image (a webview reload lost its state) — id-keyed, idempotent. */
    const replay = (): void => { sentImages.clear(); flushImages(events); render(); };

    /** Read the bytes appended since `offset`, normalize the newly-completed lines, accumulate. */
    const consume = (path: string): boolean => {
      let size: number;
      try { size = fs.statSync(path).size; } catch { return false; }
      if (size < offset) { offset = 0; partial = ""; events = []; norm = createClaudeNormalizer(path); sentImages.clear(); } // truncated/replaced
      if (size === offset) return false;
      let chunk: string;
      const fd = fs.openSync(path, "r");
      try {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        chunk = partial + buf.toString("utf8");
      } finally { fs.closeSync(fd); }
      offset = size;
      const lines = chunk.split("\n");
      partial = lines.pop() ?? ""; // last element is an incomplete (un-terminated) line — buffer it
      const fresh = norm.push(lines);
      if (fresh.length) { events.push(...fresh); flushImages(fresh); }
      return fresh.length > 0 || events.length > 0;
    };

    const onChange = (cur: fs.Stats, prev: fs.Stats): void => {
      if (disposed || !watched) return;
      if (cur.mtimeMs === prev.mtimeMs) return; // watchFile fires on poll; only act on a real change
      try { if (consume(watched)) render(); } catch { /* transient read race during a flush — next poll catches up */ }
    };
    const unwatch = (): void => { if (watched) { fs.unwatchFile(watched, onChange); watched = undefined; } };

    const resolve = async (): Promise<void> => {
      if (disposed) return;
      const mine = gen;
      const loc = await ws.manager.transcriptPathOf(agent, { live: true }).catch(() => undefined);
      if (disposed || mine !== gen) return; // panel closed or re-pointed while we awaited — drop this result
      if (!loc) {
        // No structured transcript (capture-only runtime, gone session, or pre-first-flush) → honest degrade.
        unwatch();
        post({ tier: "raw-only", summary: { messages: 0, toolsRunning: 0, toolsFailed: 0, filesChanged: [], filesReferenced: [], tokens: { input: 0, output: 0 } }, items: [] });
        return;
      }
      if (loc.path !== watched) {
        gen++; // invalidate any other in-flight resolve before we re-point
        unwatch();
        watched = loc.path;
        offset = 0; partial = ""; events = []; norm = createClaudeNormalizer(loc.path); sentImages.clear(); // fresh stream for the new session
        fs.watchFile(loc.path, { interval: 500 }, onChange); // mtime poll — robust on WSL, no fs.watch flake
        try { if (consume(loc.path)) render(); } catch { /* ignore until the next change */ }
      }
    };

    void resolve();
    const reresolve = setInterval(() => void resolve(), 4000);
    return { stop: () => { disposed = true; clearInterval(reresolve); unwatch(); }, replay };
  }

  dispose(): void {
    for (const { panel } of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}

function getNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function html(webview: vscode.Webview, codiconUri: vscode.Uri, scriptUri: vscode.Uri, agent: string): string {
  const nonce = getNonce();
  const title = agent.replace(/[<>&]/g, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
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

  /* Chat transcript: human bubbles right, agent bubbles left, activity chips threaded on the agent side */
  .feed { padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; max-width: 980px; margin: 0 auto; }
  .msg { display: flex; }
  .msg.user { justify-content: flex-end; }
  .msg.agent { justify-content: flex-start; }
  .msg .bubble { max-width: 80%; padding: 8px 12px; border-radius: 14px; line-height: 1.45; }
  .msg .btext { overflow-wrap: anywhere; }
  .msg.user .btext { white-space: pre-wrap; }
  .msg .btime { font-size: 10px; opacity: .6; margin-top: 3px; text-align: right; }
  .msg.user .bubble { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-bottom-right-radius: 4px; }
  .msg.agent .bubble { background: var(--vscode-editorWidget-background, var(--vscode-input-background)); color: var(--vscode-foreground); border: 1px solid var(--border); border-bottom-left-radius: 4px; }

  /* Markdown inside an agent bubble */
  .md p { margin: 0 0 6px; white-space: pre-wrap; }
  .md p:last-child { margin-bottom: 0; }
  .md .md-h { font-weight: 600; margin: 4px 0; }
  .md ul, .md ol { margin: 4px 0; padding-left: 20px; }
  .md li { margin: 1px 0; }
  .md code { font-family: var(--vscode-editor-font-family, monospace); font-size: .92em; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.18)); padding: 0 4px; border-radius: 3px; }
  .md pre { margin: 6px 0; padding: 8px 10px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.14)); border-radius: 6px; overflow-x: auto; }
  .md pre code { background: none; padding: 0; }
  .md a { color: var(--link); }
  .msg.user .md a { color: var(--vscode-button-foreground); text-decoration: underline; }
  .msg.user .md code { background: rgba(255,255,255,.2); }

  /* Day separator */
  .daysep { text-align: center; margin: 8px 0 2px; }
  .daysep span { font-size: 10px; color: var(--muted); background: var(--vscode-editorWidget-background, var(--vscode-input-background)); border: 1px solid var(--border); border-radius: 10px; padding: 1px 10px; }

  /* Thinking — collapsible reasoning on the agent side */
  .think { align-self: flex-start; max-width: 82%; }
  .think-toggle { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted); font-style: italic; max-width: 100%; }
  .think-toggle:hover { color: var(--vscode-foreground); }
  .think-toggle .codicon { font-size: 12px; flex: none; }
  .think-prev { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .think-body { margin: 4px 0 2px 18px; padding: 6px 10px; border-left: 2px solid var(--border); color: var(--muted); font-size: 12px; }

  /* Image bubble */
  .bubble.img { padding: 4px; }
  .bubble.img img { max-width: min(340px, 100%); max-height: 340px; border-radius: 8px; display: block; }
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

  /* Jump-to-latest */
  .jump { position: fixed; right: 18px; bottom: 18px; display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); box-shadow: 0 2px 10px rgba(0,0,0,.4); z-index: 5; }
  .jump:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  @keyframes spin { to { transform: rotate(360deg); } }

  .degrade { padding: 48px 24px; text-align: center; color: var(--muted); }
  .degrade .codicon { font-size: 28px; opacity: .5; display: block; margin: 0 auto 10px; }
  .degrade .term { display: inline-flex; align-items: center; gap: 6px; margin-top: 14px; padding: 5px 12px; border-radius: 4px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
