import * as vscode from "vscode";
import * as fs from "node:fs";
import type { Workspace } from "../workspace/Workspace.js";
import { createClaudeNormalizer, type ClaudeNormalizer } from "../activity/claudeNormalizer.js";
import { buildActivityView, type ActivityViewModel } from "../activity/activityView.js";
import type { NormalizedEvent } from "../activity/types.js";

/** Cap the feed posted to the webview so payloads stay bounded on a long session (the summary stays
 *  cumulative; only the rendered tail is trimmed). */
const MAX_ITEMS = 600;

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
    const stop = this.watch(ws, agent, post);

    panel.webview.onDidReceiveMessage((m: ActivityMsg) => {
      if (m?.type === "openFile" && m.path && knownPaths.has(m.path)) {
        void vscode.window.showTextDocument(vscode.Uri.file(m.path), { preview: true, viewColumn: vscode.ViewColumn.Beside });
      } else if (m?.type === "transcript" && transcriptPath) {
        // The raw JSONL the runtime records the session into — opened read-only beside the cockpit.
        void vscode.window.showTextDocument(vscode.Uri.file(transcriptPath), { preview: true, viewColumn: vscode.ViewColumn.Beside });
      } else if (m?.type === "terminal") {
        void vscode.commands.executeCommand("tachyon.openAgentTerminalItem", agent, ws.wsHash);
      }
      // "ready" is implicit — the watcher pushes the first frame as soon as it resolves.
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
  private watch(ws: Workspace, agent: string, post: (vm: ActivityViewModel) => void): () => void {
    let watched: string | undefined;
    let disposed = false;
    let gen = 0; // bumped on every (re)point so an in-flight async resolve can't write into a stale watch
    let norm: ClaudeNormalizer = createClaudeNormalizer();
    let events: NormalizedEvent[] = [];
    let offset = 0;
    let partial = "";

    const render = (): void => post(buildActivityView(events, { tier: "structured" }));

    /** Read the bytes appended since `offset`, normalize the newly-completed lines, accumulate. */
    const consume = (path: string): boolean => {
      let size: number;
      try { size = fs.statSync(path).size; } catch { return false; }
      if (size < offset) { offset = 0; partial = ""; events = []; norm = createClaudeNormalizer(path); } // truncated/replaced
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
      if (fresh.length) events.push(...fresh);
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
        offset = 0; partial = ""; events = []; norm = createClaudeNormalizer(loc.path); // fresh stream for the new session
        fs.watchFile(loc.path, { interval: 500 }, onChange); // mtime poll — robust on WSL, no fs.watch flake
        try { if (consume(loc.path)) render(); } catch { /* ignore until the next change */ }
      }
    };

    void resolve();
    const reresolve = setInterval(() => void resolve(), 4000);
    return () => { disposed = true; clearInterval(reresolve); unwatch(); };
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
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

  .feed { padding: 6px 0; }
  .it { display: flex; gap: 10px; padding: 6px 16px; align-items: flex-start; }
  .it:hover { background: var(--vscode-list-hoverBackground); }
  .it .codicon { font-size: 14px; flex: none; margin-top: 2px; opacity: .85; }
  .it .body { min-width: 0; flex: 1; }
  .it .t { white-space: pre-wrap; overflow-wrap: anywhere; }
  .it.message .t { color: var(--vscode-foreground); }
  .it.tool .t, .it.file .t { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .it .d { color: var(--muted); font-size: 11px; margin-top: 1px; }
  .it.err .codicon, .it.err .t { color: var(--err); }
  .it .flink { color: var(--link); text-decoration: none; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .it .flink:hover { text-decoration: underline; }

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
