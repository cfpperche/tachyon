import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import * as fs from "node:fs";
import type { Workspace } from "../workspace/Workspace.js";
import { HANDOFF_TEMPLATE } from "../handoff/ProjectHandoffStore.js";
import type { HandoffViewModel, HandoffNoteVM, HandoffDistillTargetVM } from "./handoff/handoffViewModel.js";
import { renderWebviewShell } from "./shared/shell.js";
import { READY } from "./shared/ready.js";
import { handoffMessage, type HandoffAction } from "./handoff/messages.js";
import {
  buildDistillTargets,
  buildHandoffDistillCommand,
  buildHandoffDistillPrompt,
  HANDOFF_DISTILL_PROFILES,
  normalizeAdditionalInstruction,
  normalizeHandoffDistillArgs,
  resolveHandoffDistillProfile,
  type HandoffDistillRuntime,
} from "./handoff/distill.js";
import { notify } from "../workspace/NotificationService.js";

export const HANDOFF_VIEW_TYPE = "tachyonHandoff";

export interface HandoffPanelState {
  schemaVersion: 1;
  view: typeof HANDOFF_VIEW_TYPE;
  wsHash: string;
}

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

  open(wsHash?: string, revivedPanel?: vscode.WebviewPanel): void {
    const ws = wsHash === undefined ? this.getWorkspaces()[0] : this.getWorkspaces().find((w) => w.wsHash === wsHash);
    if (!ws) { revivedPanel?.dispose(); return; }
    const key = ws.wsHash;
    const existing = this.panels.get(key);
    if (existing) {
      revivedPanel?.dispose();
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const panel = revivedPanel ?? vscode.window.createWebviewPanel(
      HANDOFF_VIEW_TYPE,
      `Handoff — ${ws.folderName}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      // t-b5e6e5 — the native VS Code find widget (Ctrl+F), piggybacking on Mission Control's validation.
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true, enableFindWidget: true },
    );
    this.attachPanel(panel, ws);
  }

  deserialize(panel: vscode.WebviewPanel, state: HandoffPanelState): void {
    this.open(state.wsHash, panel);
  }

  private attachPanel(panel: vscode.WebviewPanel, ws: Workspace): void {
    const key = ws.wsHash;
    const existing = this.panels.get(key);
    if (existing && existing.panel !== panel) existing.panel.dispose();
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    panel.title = `Handoff — ${ws.folderName}`;
    panel.webview.options = { enableScripts: true, localResourceRoots: [root] };
    panel.iconPath = panelIcon(this.extensionUri, "book"); // spec 282 — contextual editor-tab icon
    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title: `Handoff — ${ws.folderName}`,
      styles: [uri("codicon.css"), uri("design-system.css"), uri("mermaid-block.css"), uri("handoff.css")],
      bundle: uri("handoff.js"),
      mode: "live",
      persistedState: { schemaVersion: 1, view: HANDOFF_VIEW_TYPE, wsHash: ws.wsHash } satisfies HandoffPanelState,
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
          distillTargets: await distillTargets(ws),
          distillProfiles: HANDOFF_DISTILL_PROFILES,
        };
        void panel.webview.postMessage(handoffMessage(vm));
      })().catch((err) => {
        notify(`Could not refresh Project Handoff: ${err instanceof Error ? err.message : String(err)}`, "warn");
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
          notify("Invalid handoff distillation request.", "warn");
          return;
        }
        void startDistill(ws, action).catch((err) => {
          notify(`Could not start handoff distillation: ${err instanceof Error ? err.message : String(err)}`, "error");
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

/** t-1ba76d — declared agents (any state) + live ad-hoc; ordered running → resumable → stopped. */
async function distillTargets(ws: Workspace): Promise<HandoffDistillTargetVM[]> {
  const rows = await ws.manager.list();
  const resumable = new Set(ws.resumableAgents());
  // Ledger resume rows still count when the activation offer list was already consumed.
  for (const [name, rec] of ws.ledger.all()) {
    if (rec.resume) resumable.add(name);
  }
  return buildDistillTargets(rows, resumable);
}

const DISTILL_READY_TIMEOUT_MS = 45_000;
const DISTILL_READY_POLL_MS = 250;

async function waitUntilAgentLive(ws: Workspace, name: string, timeoutMs = DISTILL_READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = (await ws.manager.list()).find((a) => a.name === name);
    if (row && row.kind === "agent" && row.running && !row.dead && !row.stopping) return;
    await new Promise((r) => setTimeout(r, DISTILL_READY_POLL_MS));
  }
  throw new Error(`agent '${name}' did not become ready in time for distillation`);
}

async function ensureDistillAgentLive(ws: Workspace, agent: string): Promise<void> {
  const row = (await ws.manager.list()).find((a) => a.name === agent);
  if (!row || row.kind !== "agent") throw new Error(`agent '${agent}' is not a managed AI agent`);
  if (row.running && !row.dead && !row.stopping) return;

  const hasResume = !!ws.ledger.get(agent)?.resume || ws.resumableAgents().includes(agent);
  if (hasResume) {
    await ws.resumeAgent(agent);
  } else if (row.declared) {
    await ws.manager.spawn(agent, { reveal: true });
  } else {
    throw new Error(`agent '${agent}' is stopped and cannot be resumed or respawned`);
  }
  await waitUntilAgentLive(ws, agent);
}

async function startDistill(ws: Workspace, action: Extract<HandoffAction, { type: "distill" }>): Promise<void> {
  const prompt = buildHandoffDistillPrompt({ additionalInstruction: normalizeAdditionalInstruction(action.instructions) });
  if (action.mode === "existing") {
    const agent = typeof action.agent === "string" ? action.agent.trim() : "";
    if (!agent) throw new Error("missing target agent");
    const target = (await distillTargets(ws)).find((t) => t.name === agent);
    if (!target) throw new Error(`agent '${agent}' is not a distill target (declared or running ad-hoc)`);
    await ensureDistillAgentLive(ws, agent);
    await ws.tmux.sendKeys(ws.manager.session(agent), prompt, true);
    notify(`Handoff distillation task sent to '${agent}'.`);
    return;
  }

  const profile = resolveHandoffDistillProfile(action.profileId);
  if (!profile) throw new Error(`unsupported distill profile '${String(action.profileId)}'`);
  const cmd = buildHandoffDistillCommand(profile, action.args);
  const name = await uniqueDistillAgentName(ws, profile.runtime);
  await ws.manager.spawn(name, { cmd, instructions: prompt, reveal: true });
  notify(`Handoff distillation agent '${name}' started.`);
}

function parseDistillAction(m: Partial<HandoffAction>): Extract<HandoffAction, { type: "distill" }> | null {
  if (m.type !== "distill") return null;
  if (m.mode === "existing" && typeof m.agent === "string") {
    return { type: "distill", mode: "existing", agent: m.agent, ...(typeof m.instructions === "string" ? { instructions: m.instructions } : {}) };
  }
  if (m.mode === "adhoc" && typeof m.profileId === "string") {
    return {
      type: "distill",
      mode: "adhoc",
      profileId: m.profileId,
      ...(typeof m.instructions === "string" ? { instructions: m.instructions } : {}),
      ...(normalizeHandoffDistillArgs(m.args) ? { args: normalizeHandoffDistillArgs(m.args) } : {}),
    };
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
