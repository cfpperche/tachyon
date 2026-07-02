import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import * as fs from "node:fs";
import type { Workspace } from "../workspace/Workspace.js";
import { HANDOFF_TEMPLATE } from "../handoff/ProjectHandoffStore.js";
import type { HandoffViewModel, HandoffNoteVM, HandoffDistillTargetVM } from "./handoff/handoffViewModel.js";
import { renderWebviewShell } from "./shared/shell.js";
import { READY } from "./shared/ready.js";
import { handoffMessage, type HandoffAction } from "./handoff/messages.js";
import { buildHandoffDistillPrompt, HANDOFF_DISTILL_RUNTIMES, isHandoffDistillRuntime, normalizeAdditionalInstruction, runtimeCommand, type HandoffDistillRuntime } from "./handoff/distill.js";

/**
 * spec 245 inc D — the Project Handoff editor-area panel (one per workspace root). A read-only DOCUMENT view
 * of the shared, curated handoff (`.tachyon/HANDOFF.md`) + the pending-note lane + a staleness badge. Mirrors
 * the ActivityPanelManager (spec 238): createWebviewPanel + asWebviewUri(dist/webview/handoff.js) + a single
 * snapshot postMessage, re-posted when the engine fires onViewsChanged("handoff"). No live-tail / paging — the
 * handoff is a small static doc, not a growing feed. The ENGINE owns the snapshot; the UI renders it.
 */
export class HandoffPanelManager {
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; post: () => void }>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getWorkspaces: () => Workspace[],
  ) {}

  open(wsHash?: string): void {
    const ws = wsHash === undefined ? this.getWorkspaces()[0] : this.getWorkspaces().find((w) => w.wsHash === wsHash);
    if (!ws) return;
    const key = ws.wsHash;
    const existing = this.panels.get(key);
    if (existing) { existing.panel.reveal(vscode.ViewColumn.Active); return; }

    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const panel = vscode.window.createWebviewPanel(
      "tachyonHandoff",
      `Handoff — ${ws.folderName}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true },
    );
    panel.iconPath = panelIcon(this.extensionUri, "book"); // spec 282 — contextual editor-tab icon
    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title: `Handoff — ${ws.folderName}`,
      styles: [uri("codicon.css"), uri("design-system.css"), uri("handoff.css")],
      bundle: uri("handoff.js"),
      mode: "live",
    });

    const post = (): void => {
      void (async () => {
        const snap = ws.handoffStore.snapshot(ws.lastActivityAt?.() ?? null);
        // inc G — the snapshot now carries the pending rows (one source for the panel + the Bridge `get`; no
        // re-implementing the pending rule here — keeps list + badge count in lockstep).
        const notes: HandoffNoteVM[] = snap.pending.map((n) => ({ ts: n.ts, agent: n.agent, kind: n.kind, summary: n.summary, evidence: n.evidence }));
        const vm: HandoffViewModel = {
          folder: ws.folderName,
          exists: snap.exists,
          body: snap.body,
          staleness: snap.staleness,
          pendingCount: snap.pendingCount,
          updatedAt: snap.meta?.updated_at ?? "",
          updatedBy: snap.meta?.updated_by ?? "",
          revision: snap.revision,
          notes,
          distillTargets: await runningDistillTargets(ws),
          distillRuntimes: HANDOFF_DISTILL_RUNTIMES,
        };
        void panel.webview.postMessage(handoffMessage(vm));
      })().catch((err) => {
        void vscode.window.showWarningMessage(`Could not refresh Project Handoff: ${err instanceof Error ? err.message : String(err)}`);
      });
    };

    // spec 280 — type the inbound message so a typo'd `m.type === "…"` is a compile error (the typed-union
    // convention shared with sidebar/activity/pin-studio); the field stays optional (the message is untrusted).
    panel.webview.onDidReceiveMessage((m: Partial<HandoffAction>) => {
      if (m?.type === READY || m?.type === "refresh") { post(); return; } // (re)loaded webview / explicit refresh
      if (m?.type === "openFile") {
        // Open the canonical handoff read/write; create it from the 4-section template when it doesn't exist
        // yet (the cold-start "Open" affordance) so the user lands in a real, editable file.
        const filePath = ws.handoffStore.canonicalPath;
        if (!fs.existsSync(filePath)) {
          ws.handoffStore.setCanonical(HANDOFF_TEMPLATE, undefined, "human");
          post(); // the file now exists → refresh the panel out of the cold-start state
        }
        void vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: false, viewColumn: vscode.ViewColumn.Beside });
      }
      if (m?.type === "distill") {
        const action = parseDistillAction(m);
        if (!action) {
          void vscode.window.showWarningMessage("Invalid handoff distillation request.");
          return;
        }
        void startDistill(ws, action).catch((err) => {
          void vscode.window.showErrorMessage(`Could not start handoff distillation: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    });

    panel.onDidDispose(() => { this.panels.delete(key); });
    this.panels.set(key, { panel, post });
    post();
  }

  /** Re-post the snapshot to an open panel for this workspace (wired into onViewsChanged("handoff")). */
  refresh(wsHash: string): void {
    this.panels.get(wsHash)?.post();
  }

  /** Re-post to every open panel — onViewsChanged("handoff") carries no wsHash, so refresh them all (cheap). */
  refreshAll(): void {
    for (const { post } of this.panels.values()) post();
  }

  dispose(): void {
    for (const { panel } of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}

async function runningDistillTargets(ws: Workspace): Promise<HandoffDistillTargetVM[]> {
  return (await ws.manager.list())
    .filter((a) => a.kind === "agent" && a.running && !a.dead && !a.stopping)
    .map((a) => ({ name: a.name, description: a.declared ? "declared agent" : "ad-hoc agent" }));
}

async function startDistill(ws: Workspace, action: Extract<HandoffAction, { type: "distill" }>): Promise<void> {
  const prompt = buildHandoffDistillPrompt({ additionalInstruction: normalizeAdditionalInstruction(action.instructions) });
  if (action.mode === "existing") {
    const agent = typeof action.agent === "string" ? action.agent.trim() : "";
    if (!agent) throw new Error("missing target agent");
    const target = (await runningDistillTargets(ws)).find((t) => t.name === agent);
    if (!target) throw new Error(`agent '${agent}' is not a running AI agent`);
    await ws.tmux.sendKeys(ws.manager.session(agent), prompt, true);
    void vscode.window.showInformationMessage(`Handoff distillation task sent to '${agent}'.`);
    return;
  }

  if (!isHandoffDistillRuntime(action.runtime)) throw new Error(`unsupported runtime '${String(action.runtime)}'`);
  const name = await uniqueDistillAgentName(ws, action.runtime);
  await ws.manager.spawn(name, { cmd: runtimeCommand(action.runtime), instructions: prompt, reveal: true });
  void vscode.window.showInformationMessage(`Handoff distillation agent '${name}' started.`);
}

function parseDistillAction(m: Partial<HandoffAction>): Extract<HandoffAction, { type: "distill" }> | null {
  if (m.type !== "distill") return null;
  if (m.mode === "existing" && typeof m.agent === "string") {
    return { type: "distill", mode: "existing", agent: m.agent, ...(typeof m.instructions === "string" ? { instructions: m.instructions } : {}) };
  }
  if (m.mode === "adhoc" && typeof m.runtime === "string") {
    return { type: "distill", mode: "adhoc", runtime: m.runtime, ...(typeof m.instructions === "string" ? { instructions: m.instructions } : {}) };
  }
  return null;
}

async function uniqueDistillAgentName(ws: Workspace, runtime: HandoffDistillRuntime): Promise<string> {
  const existing = new Set((await ws.manager.list()).map((a) => a.name));
  const base = `handoff-${runtime}-${Date.now().toString(36).slice(-6)}`;
  if (!existing.has(base)) return base;
  for (let i = 2; i < 20; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `handoff-${runtime}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
