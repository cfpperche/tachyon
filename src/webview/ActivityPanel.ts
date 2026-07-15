import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { WorkspaceActivityTarget } from "../shell/ActivityTarget.js";
import { createActivityBuilder, type ActivityBuilder, type ActivityViewModel } from "../activity/activityView.js";
import { activityMessage, COPY_SHARE_TEXT, imageDataMessage, SHARE_EXTERNAL, SHARE_TO_AGENT, type ActivityWebviewMessage } from "./activity/messages.js";
import { renderWebviewShell } from "./shared/shell.js";
import { ActivityLog, type LoggedEvent } from "../activity/logStore.js";
import type { NormalizedEvent } from "../activity/types.js";
import { internalSharePrompt, resolveActivityShare, withActivityShareKeys, type ActivitySharePayload } from "../activity/activityShare.js";
import { notify, showNotification } from "../workspace/NotificationService.js";

/** Cap the feed posted to the webview so payloads stay bounded on a long session (only the rendered tail). */
const MAX_ITEMS = 600;

/** Bound the INITIAL read to the last N log records (spec 239 inc 4 reads the durable log, not the runtime). */
const MAX_TAIL_RECORDS = 4000;

/** Raster image types we'll build a data: URI for — SVG is excluded (it can carry script). */
const ALLOWED_IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Backward-paging page sizes (spec 239 inc 6): each "load earlier" grows the shown items by PAGE_ITEMS and,
 *  when that outruns the in-memory window, re-reads PAGE_RECORDS more log records — up to a hard cap, beyond
 *  which the view stops offering "load earlier" and points to the full transcript (bounds the postMessage). */
const PAGE_ITEMS = 600;
const PAGE_RECORDS = 4000;
const MAX_SHOWN_ITEMS = 5000;
const MAX_WINDOW_RECORDS = 40000;

export const ACTIVITY_VIEW_TYPE = "tachyonActivity";

export interface ActivityPanelState {
  schemaVersion: 1;
  view: typeof ACTIVITY_VIEW_TYPE;
  wsHash: string;
  agent: string;
}

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
    private readonly getWorkspaces: () => WorkspaceActivityTarget[],
  ) {}

  open(agent: string, wsHash?: string): void {
    const ws = wsHash === undefined ? this.getWorkspaces()[0] : this.getWorkspaces().find((w) => w.wsHash === wsHash);
    if (!ws) return;
    const key = `${ws.wsHash}::${agent}`;
    const existing = this.panels.get(key);
    if (existing) { existing.panel.reveal(vscode.ViewColumn.Active); return; }

    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const panel = vscode.window.createWebviewPanel(
      ACTIVITY_VIEW_TYPE,
      agent,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true },
    );
    this.attachPanel(panel, ws, agent);
  }

  deserialize(panel: vscode.WebviewPanel, state: ActivityPanelState): void {
    const ws = this.getWorkspaces().find((w) => w.wsHash === state.wsHash);
    if (!ws) { panel.dispose(); return; }
    this.attachPanel(panel, ws, state.agent);
  }

  private attachPanel(panel: vscode.WebviewPanel, ws: WorkspaceActivityTarget, agent: string): void {
    const key = `${ws.wsHash}::${agent}`;
    const existing = this.panels.get(key);
    if (existing && existing.panel !== panel) existing.panel.dispose();
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    panel.title = agent;
    panel.webview.options = { enableScripts: true, localResourceRoots: [root] };
    panel.iconPath = panelIcon(this.extensionUri, "pulse"); // spec 282 — contextual editor-tab icon
    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    const codeTheme = vscode.workspace.getConfiguration("tachyon").get<string>("activity.codeTheme", "auto");
    const themeClass = codeTheme === "dark" ? "tac-theme-dark" : codeTheme === "light" ? "tac-theme-light" : "";
    // spec 280 — the on-demand mermaid/katex URLs + the code-theme reach the bundle via the shell's nonce'd
    // bootstrap globals (JSON-encoded; the bundle injects mermaid/katex only when a math/diagram block appears).
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title: agent.replace(/[<>&]/g, ""),
      styles: [uri("codicon.css"), uri("design-system.css"), uri("mermaid-block.css"), uri("activity.css")],
      bundle: uri("activity.js"),
      mode: "live",
      bodyClass: themeClass || undefined,
      bootstrapGlobals: {
        __mermaidSrc: uri("mermaid.js"),
        __katexSrc: uri("katex.js"),
        __katexCssUri: uri("katex.min.css"),
        __codeThemeForced: codeTheme,
      },
      persistedState: { schemaVersion: 1, view: ACTIVITY_VIEW_TYPE, wsHash: ws.wsHash, agent } satisfies ActivityPanelState,
    });

    // The set of file paths the host has actually surfaced — openFile is restricted to these (the webview
    // can't ask the host to open an arbitrary path).
    let knownPaths = new Set<string>();
    let transcriptPath: string | undefined; // the host's own resolved transcript path (not webview-supplied)
    let latestVm: ActivityViewModel | undefined;
    // Surface an honest notice only for real attribution gaps. Computed async because the live transcript
    // resolver may consult the ownership ledger; open without a pessimistic false-positive banner.
    let sharedCwd = false;
    const post = (vm: ActivityViewModel, prepended?: boolean): void => {
      const shareVm = withActivityShareKeys(agent, vm);
      latestVm = shareVm;
      knownPaths = new Set([...shareVm.summary.filesChanged, ...shareVm.summary.filesReferenced]);
      transcriptPath = shareVm.sourcePath;
      // `vm.items` is already sliced to the shown window by the watcher's render() (backward paging grows it);
      // Live work state from the AttentionMonitor (same signal as the sidebar "working" pill). `prepended` (one-shot)
      // tells the webview THIS specific VM grew older items at the top → keep the scroll anchored (not a live append).
      // spec 306 — "throttled" has no Activity-view equivalent yet (neither "typing" nor "needs your input" is
      // true); the sidebar dot/badge/toast already cover visibility, so this narrower live-state hint just omits
      // it rather than misrepresenting it or growing AgentActivityState for a surface this spec doesn't touch.
      const rawState = ws.activityAttention(agent);
      const agentState = rawState === "throttled" ? undefined : rawState;
      // spec 278 — POST via the shared envelope (the dev preview harness uses the same constructor).
      void panel.webview.postMessage(activityMessage({ ...shareVm, agentState, sharedCwd }, prepended));
    };
    void ws.activityContext(agent).then((context) => {
      sharedCwd = context.sharedCwd;
      if (latestVm) post(latestVm);
    }).catch(() => undefined);
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
        notify("Source transcript is no longer on disk — the rendered activity is preserved in Tachyon's durable log.");
      }
    };

    panel.webview.onDidReceiveMessage((m: ActivityWebviewMessage) => {
      if (m?.type === "ready") { replay(); return; } // a (re)loaded webview → re-push the VM + resend images
      if (m?.type === "openFile" && m.path && knownPaths.has(m.path)) {
        void vscode.window.showTextDocument(vscode.Uri.file(m.path), { preview: true, viewColumn: vscode.ViewColumn.Beside });
      } else if (m?.type === "terminal") {
        void vscode.commands.executeCommand("tachyon.openAgentTerminalItem", agent, ws.wsHash);
      } else if (m?.type === "loadOlder") {
        loadOlder(); // grow the rendered window backward (spec 239 inc 6)
      } else if (m?.type === COPY_SHARE_TEXT) {
        void this.copyShareText(agent, latestVm, m.sequence, m.key);
      } else if (m?.type === SHARE_EXTERNAL) {
        void this.shareExternal(agent, latestVm, m.sequence, m.key);
      } else if (m?.type === SHARE_TO_AGENT) {
        void this.shareToAgent(ws, agent, latestVm, m.sequence, m.key).catch((error) => {
          notify(`Could not share Activity context: ${error instanceof Error ? error.message : String(error)}`, "warn");
        });
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
      notify("Open an agent's Activity view first, then run “Open Raw Transcript”.");
      return;
    }
    entry.openTranscript();
  }

  private resolveShare(agent: string, vm: ActivityViewModel | undefined, sequence: unknown, key: unknown): ActivitySharePayload | undefined {
    const resolved = resolveActivityShare(agent, vm, sequence, key);
    if (!resolved.ok) {
      notify("That Activity item is no longer available. Refresh the Activity view and try again.", "warn");
      return undefined;
    }
    return resolved.payload;
  }

  private async shareExternal(agent: string, vm: ActivityViewModel | undefined, sequence: unknown, key: unknown): Promise<void> {
    const payload = this.resolveShare(agent, vm, sequence, key);
    if (!payload) return;
    const picked = await vscode.window.showQuickPick([
      { label: "Email", id: "email" as const, description: "Open a mail draft" },
      { label: "WhatsApp", id: "whatsapp" as const, description: "Open WhatsApp Web" },
    ], { placeHolder: "Share Activity item" });
    if (!picked) return;
    const preview = payload.text.length > 1400 ? `${payload.text.slice(0, 1400).trimEnd()}\n\n[preview truncated]` : payload.text;
    const ok = await showNotification(`Share this Activity item via ${picked.label}?`, "info", ["Open"], { modal: true, detail: preview });
    if (ok !== "Open") return;
    if (picked.id === "email") {
      const subject = encodeURIComponent(`Tachyon Activity from ${agent}`);
      const body = encodeURIComponent(payload.urlText);
      await vscode.env.openExternal(vscode.Uri.parse(`mailto:?subject=${subject}&body=${body}`));
    } else {
      await vscode.env.openExternal(vscode.Uri.parse(`https://wa.me/?text=${encodeURIComponent(payload.urlText)}`));
    }
  }

  private async copyShareText(agent: string, vm: ActivityViewModel | undefined, sequence: unknown, key: unknown): Promise<void> {
    const payload = this.resolveShare(agent, vm, sequence, key);
    if (!payload) return;
    await vscode.env.clipboard.writeText(payload.text);
    notify("Activity share text copied.");
  }

  private async shareToAgent(ws: WorkspaceActivityTarget, sourceAgent: string, vm: ActivityViewModel | undefined, sequence: unknown, key: unknown): Promise<void> {
    const payload = this.resolveShare(sourceAgent, vm, sequence, key);
    if (!payload) return;
    const targets = await this.runningAgentTargets(ws, sourceAgent);
    if (targets.length === 0) {
      notify("No other running Tachyon agent is available for this Activity share.");
      return;
    }
    const picked = await vscode.window.showQuickPick(targets.map((t) => ({ label: t.name, description: t.description })), { placeHolder: "Send Activity item to agent" });
    if (!picked) return;
    const stillLive = (await this.runningAgentTargets(ws, sourceAgent)).some((t) => t.name === picked.label);
    if (!stillLive) {
      notify(`Agent '${picked.label}' is no longer available.`, "warn");
      return;
    }
    const prompt = internalSharePrompt(payload);
    const preview = prompt.length > 1400 ? `${prompt.slice(0, 1400).trimEnd()}\n\n[preview truncated]` : prompt;
    const ok = await showNotification(`Paste Activity context into '${picked.label}'?`, "info", ["Paste"], { modal: true, detail: preview });
    if (ok !== "Paste") return;
    await ws.sendAgentInput(picked.label, prompt, false);
    notify(`Activity context pasted into '${picked.label}' (not submitted).`);
  }

  private async runningAgentTargets(ws: WorkspaceActivityTarget, sourceAgent: string): Promise<Array<{ name: string; description: string }>> {
    const context = await ws.activityContext(sourceAgent);
    return context.targets.items.map((target) => ({
      name: target.name,
      description: target.declared ? "declared agent" : "ad-hoc agent",
    }));
  }

  /**
   * spec 239 inc 4 — render from the DURABLE per-agent log (`.tachyon/activity/<agent>.jsonl`), NOT the runtime
   * transcript. The always-on ActivityLogManager writer owns runtime tailing + session resolution + stitching;
   * the panel is a pure read-only subscriber: bounded initial read (last N log records) + forward tail of the
   * log as the writer appends (offset + raw-byte partial — the same inc-2 seam, now on the log). Multi-session
   * stitch is automatic (the log already spans sessions); `session.boundary` records render as separators.
   */
  private watch(ws: WorkspaceActivityTarget, agent: string, post: (vm: ActivityViewModel, prepended?: boolean) => void, postImage: (id: string, dataUri: string) => void): { stop: () => void; replay: () => void; loadOlder: () => void } {
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
      model: e.model, effort: e.effort,
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
      const st = ws.activityAttention(agent);
      if (st !== lastState) { lastState = st; render(); }
    }, 1000);
    return { stop: () => { disposed = true; clearInterval(stateTimer); fs.unwatchFile(logFile, onChange); }, replay, loadOlder };
  }

  dispose(): void {
    for (const { panel } of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}
