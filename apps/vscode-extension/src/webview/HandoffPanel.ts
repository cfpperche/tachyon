import * as vscode from "vscode";
import type { WorkspaceHandoffTarget } from "../shell/HandoffTarget.js";
import { HANDOFF_DISTILL_PROFILES, normalizeAdditionalInstruction, normalizeHandoffDistillArgs } from "@tachyon/shared/handoff/distill.js";
import { parseHandoffDistillInputV1, type HandoffDistillInputV1 } from "@tachyon/engine/runtime-api/handoffCommands.js";
import { notify } from "../workspace/NotificationService.js";
import { handoffMessage, type HandoffAction } from "@tachyon/webview-ui/webview/handoff/messages";
import type { HandoffDistillTargetVM, HandoffNoteVM, HandoffViewModel } from "@tachyon/webview-ui/webview/handoff/handoffViewModel";
import { SectionPanelManager, type SectionAppConfig, type SectionPanelSession, type SectionPanelState, type SectionPanelTarget } from "./shared/SectionPanelManager.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";

/** Reused from the pre-410 standalone panel: the id still names this app and its wsHash maps exactly to a dashboard project key. */
export const HANDOFF_VIEW_TYPE = "tachyonHandoff";
export interface HandoffPanelState { schemaVersion: 1; view: typeof HANDOFF_VIEW_TYPE; wsHash: string; }
type RefreshKind = "handoff";
export interface HandoffPanelDeps { getWorkspaces: () => WorkspaceHandoffTarget[]; }

/**
 * SDD 485 D19 — Project Handoff is a `dashboard`: one editor tab per project.
 *
 * The cardinality is visible in this dependency signature rather than in a convention: the manager resolves
 * exactly one `WorkspaceHandoffTarget` by the project carried in its panel key, and every read and action is
 * performed through that target. Two projects therefore read two different canonical files and note lanes.
 *
 * Three triggers reach it: the contributed command, legacy `tachyonHandoff` restore, and the `views-changed`
 * fan-out. They all converge on this manager; `SectionPanelManager` reveals an existing project key and gates
 * both client polling and fan-out refresh while hidden, with a full catch-up on reveal.
 */
export class HandoffPanelManager {
  private readonly manager: SectionPanelManager<RefreshKind>;
  constructor(extensionUri: vscode.Uri, private readonly deps: HandoffPanelDeps, app: WebviewAppEntry = webviewApp("handoff"), scope?: ControlWorkspaceScope) {
    this.manager = new SectionPanelManager(extensionUri, this.configFor(app), scope);
  }
  open(project: string): void { this.manager.open({ project }); }
  refresh(): number { return this.manager.refresh("handoff"); }
  markSourceResync(): void { this.manager.markSourceResync(); }
  get openKeys(): string[] { return this.manager.openKeys; }
  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState | HandoffPanelState): void {
    this.manager.deserialize(panel, "wsHash" in state ? { schemaVersion: 1, view: HANDOFF_VIEW_TYPE, project: state.wsHash } : state);
  }
  dispose(): void { this.manager.dispose(); }

  private workspace(target: SectionPanelTarget): WorkspaceHandoffTarget | undefined {
    return this.deps.getWorkspaces().find((ws) => ws.wsHash === target.project);
  }
  private configFor(app: WebviewAppEntry): SectionAppConfig<RefreshKind> {
    return {
      app,
      styleFiles: ["codicon.css", "tokens.css", "faces.css", "design-system.css", "quick-picker.css", "mermaid-block.css", "activity.css", "handoff.css"],
      title: () => vscode.l10n.t("Project Handoff"),
      refreshKindFor: handoffRefreshKind,
      bind: (session) => {
        const send = () => void this.send(session);
        return { replay: send, resync: send, onMessage: (raw) => void this.action(session, raw) };
      },
    };
  }
  private async send(session: SectionPanelSession<RefreshKind>): Promise<void> {
    const ws = this.workspace(session.target);
    if (!ws) return;
    try {
      const snap = await ws.loadHandoff();
      const notes: HandoffNoteVM[] = snap.notes.map((note) => ({ ...note, evidence: [...note.evidence] }));
      const distillTargets: HandoffDistillTargetVM[] = snap.distillTargets.map((target) => ({ ...target }));
      const vm: HandoffViewModel = { folder: ws.folderName, exists: snap.exists, body: snap.body,
        staleness: snap.staleness, pendingCount: snap.pendingCount, updatedAt: snap.updatedAt,
        updatedBy: snap.updatedBy, revision: snap.revision, notes, distillTargets,
        distillProfiles: HANDOFF_DISTILL_PROFILES };
      session.post(handoffMessage(vm));
    } catch (error) {
      notify(vscode.l10n.t("Could not refresh Project Handoff: {0}", error instanceof Error ? error.message : String(error)), "warn");
    }
  }
  private async action(session: SectionPanelSession<RefreshKind>, raw: unknown): Promise<void> {
    const message = raw as Partial<HandoffAction>;
    if (message.type === "ready" || message.type === "refresh") return;
    const ws = this.workspace(session.target);
    if (!ws) return;
    if (message.type === "openFile") {
      try {
        const filePath = await ws.ensureHandoffFile();
        await vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: false, viewColumn: vscode.ViewColumn.Beside });
        await this.send(session);
      } catch (error) {
        notify(vscode.l10n.t("Could not open Project Handoff: {0}", error instanceof Error ? error.message : String(error)), "error");
      }
      return;
    }
    const action = parseDistill(message);
    if (!action) { notify(vscode.l10n.t("Invalid handoff distillation request."), "warn"); return; }
    try {
      const result = await ws.startHandoffDistill(action);
      notify(result.mode === "existing"
        ? vscode.l10n.t("Handoff distillation task sent to '{0}'.", result.agent)
        : vscode.l10n.t("Handoff distillation agent '{0}' started.", result.agent));
    } catch (error) {
      notify(vscode.l10n.t("Could not start handoff distillation: {0}", error instanceof Error ? error.message : String(error)), "error");
    }
  }
}

export function handoffRefreshKind(message: unknown): RefreshKind | undefined {
  if (!message || typeof message !== "object") return undefined;
  const type = (message as { type?: unknown }).type;
  return type === "ready" || type === "refresh" ? "handoff" : undefined;
}

function parseDistill(message: Partial<HandoffAction>): HandoffDistillInputV1 | null {
  if (message.type !== "distill") return null;
  const temporary = message as { mode?: unknown; profileId?: unknown; args?: unknown };
  const instructions = normalizeAdditionalInstruction(message.instructions);
  const args = normalizeHandoffDistillArgs(message.mode !== "existing" ? temporary.args : undefined);
  const candidate = message.mode === "existing" && typeof message.agent === "string"
    ? { mode: "existing", agent: message.agent.trim(), ...(instructions ? { instructions } : {}) }
    : message.mode !== "existing" && typeof temporary.profileId === "string"
      ? { mode: temporary.mode, profileId: temporary.profileId, ...(args ? { args } : {}), ...(instructions ? { instructions } : {}) }
      : undefined;
  if (!candidate) return null;
  try { return parseHandoffDistillInputV1(candidate); } catch { return null; }
}
