import * as vscode from "vscode";
import type { Workspace } from "../workspace/Workspace.js";
import { SoulError } from "../agents/soul.js";
import { StudioPanelManagerBase, type StudioDomainMessageContext, type StudioPanelState, type StudioSurfaceConfig } from "./shared/studio/StudioPanelManagerBase.js";
import { envelope, type StudioRestoreSnapshot } from "./shared/studio/protocol.js";
import { AgentStudioAdapter } from "./AgentStudioAdapter.js";
import {
  projectSoulProfileStatus,
  validateAgentStudioInboundMessage,
  type AgentStudioEntity,
  type AgentStudioFields,
  type AgentStudioPatch,
  type SoulProfileStatusMessage,
} from "./agent-studio-shell/domain.js";
import { soulProfileErrorMessage, soulProfileStatusMessage } from "./agent-studio-shell/messages.js";

/**
 * spec 350 Phase 3 T2 + spec 377 T15A — Agent Studio host wiring.
 * Domain actions: browse/cwd plus typed common-path soul profile protocol.
 * Final Identity UI rendering is T16; this panel owns filesystem-backed actions only.
 */
const surface: StudioSurfaceConfig = {
  viewType: "tachyonAgentStudioShell",
  bundleFile: "agent-studio-shell.js",
  styleFiles: ["codicon.css", "design-system.css", "studio-frame.css", "agent-studio-shell.css"],
  iconName: "hubot",
};

export const AGENT_STUDIO_SHELL_VIEW_TYPE = surface.viewType;
export type AgentStudioPanelState = StudioPanelState<AgentStudioPatch>;

export class AgentStudioPanelManager {
  private readonly workspaces = new Map<string, StudioPanelManagerBase<AgentStudioEntity, AgentStudioFields, AgentStudioPatch>>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    getWorkspacesOrOnChanged?: (() => Workspace[]) | (() => void),
    onChangedMaybe?: () => void,
  ) {
    if (onChangedMaybe) {
      this.getWorkspaces = getWorkspacesOrOnChanged as () => Workspace[];
      this.onChanged = onChangedMaybe;
    } else {
      this.getWorkspaces = () => [];
      this.onChanged = (getWorkspacesOrOnChanged as (() => void) | undefined) ?? (() => {});
    }
  }

  private readonly getWorkspaces: () => Workspace[];
  private readonly onChanged: () => void;

  openNew(ws: Workspace): void {
    this.baseFor(ws).openNew(ws.wsHash);
  }

  openExisting(ws: Workspace, agentName: string): void {
    this.baseFor(ws).openExisting(ws.wsHash, agentName);
  }

  refreshAll(): void {
    for (const base of this.workspaces.values()) base.refreshAll();
  }

  dispose(): void {
    for (const base of this.workspaces.values()) base.dispose();
    this.workspaces.clear();
  }

  captureSnapshot(ws: Workspace, entityId?: string): StudioRestoreSnapshot<string, AgentStudioPatch> | undefined {
    return this.workspaces.get(ws.wsHash)?.captureSnapshot(ws.wsHash, entityId);
  }

  restoreFromSnapshot(ws: Workspace, snapshot: StudioRestoreSnapshot<string, AgentStudioPatch>): void {
    this.baseFor(ws).restoreFromSnapshot(ws.wsHash, snapshot);
  }

  deserialize(panel: vscode.WebviewPanel, state: AgentStudioPanelState): void {
    const ws = this.getWorkspaces().find((w) => w.wsHash === state.wsKey);
    if (!ws) { panel.dispose(); return; }
    this.baseFor(ws).deserializePanel(panel, state);
  }

  private baseFor(ws: Workspace): StudioPanelManagerBase<AgentStudioEntity, AgentStudioFields, AgentStudioPatch> {
    let base = this.workspaces.get(ws.wsHash);
    if (!base) {
      base = new StudioPanelManagerBase<AgentStudioEntity, AgentStudioFields, AgentStudioPatch>(
        this.extensionUri,
        surface,
        new AgentStudioAdapter(ws),
        this.onChanged,
        (ctx, message) => this.handleDomainMessage(ws, ctx, message),
      );
      this.workspaces.set(ws.wsHash, base);
    }
    return base;
  }

  private handleDomainMessage(ws: Workspace, ctx: StudioDomainMessageContext, message: { type: string }): void {
    const m = validateAgentStudioInboundMessage(message);
    if (!m) {
      this.postProfileError(ctx, ctx.entityId ?? "Agent", new SoulError("soul/path-invalid", "Rejected malformed Agent Studio profile message"));
      return;
    }
    if (m.type === "browse") {
      void this.browse(ws, ctx);
      return;
    }
    const agent = ctx.entityId;
    if (!agent || m.agent !== agent) {
      this.postProfileError(ctx, agent ?? "Agent", new SoulError("soul/path-invalid", "Profile action does not match this saved Agent Studio entity"));
      return;
    }
    if (m.type === "createSoul") { void this.runProfileAction(ws, ctx, agent, "create", () => ws.createSoulProfile(agent)); return; }
    if (m.type === "importSoul") { void this.importSoul(ws, ctx, agent); return; }
    if (m.type === "openSoul") { void this.openSoul(ws, ctx, agent); return; }
    if (m.type === "refreshSoul") { void this.refreshSoul(ws, ctx, agent, "refresh"); return; }
    if (m.type === "previewSoul") { void this.refreshSoul(ws, ctx, agent, "preview"); return; }
    if (m.type === "adoptSoulProfile") {
      void this.runProfileAction(ws, ctx, agent, "adopt", () => ws.adoptSoulProfile(agent, m.expectedDigest));
      return;
    }
    if (m.type === "enableSoul") { void this.runProfileAction(ws, ctx, agent, "enable", () => ws.enableSoulProfile(agent)); return; }
    if (m.type === "disableSoul") { void this.runProfileAction(ws, ctx, agent, "disable", () => ws.disableSoulProfile(agent)); return; }
  }

  private async browse(ws: Workspace, ctx: StudioDomainMessageContext): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(ws.workspaceRoot),
    });
    if (picked?.[0]) ctx.post(envelope({ type: "cwd" as const, value: picked[0].fsPath }));
  }

  private async importSoul(ws: Workspace, ctx: StudioDomainMessageContext, agent: string): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { Markdown: ["md", "markdown", "txt"], "All files": ["*"] },
      title: "Import SOUL.md (copied into the canonical profile)",
      defaultUri: vscode.Uri.file(ws.workspaceRoot),
    });
    const file = picked?.[0]?.fsPath;
    if (!file) return;
    // Source path stays local to this turn — never posted back or journaled.
    await this.runProfileAction(ws, ctx, agent, "import", () => ws.importSoulProfile(agent, file));
  }

  private async openSoul(ws: Workspace, ctx: StudioDomainMessageContext, agent: string): Promise<void> {
    try {
      const target = await ws.canonicalSoulPathForOpen(agent);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      await vscode.window.showTextDocument(doc, { preview: false });
      await this.refreshSoul(ws, ctx, agent, "open");
    } catch (error) {
      this.postProfileError(ctx, agent, error);
    }
  }

  private async refreshSoul(
    ws: Workspace,
    ctx: StudioDomainMessageContext,
    agent: string,
    action: NonNullable<SoulProfileStatusMessage["action"]>,
  ): Promise<void> {
    try {
      const status = await ws.refreshSoulProfile(agent);
      ctx.post(soulProfileStatusMessage(projectSoulProfileStatus(status, { action })));
    } catch (error) {
      this.postProfileError(ctx, agent, error);
    }
  }

  private async runProfileAction(
    _ws: Workspace,
    ctx: StudioDomainMessageContext,
    agent: string,
    action: NonNullable<SoulProfileStatusMessage["action"]>,
    run: () => Promise<{ status: SoulProfileStatusMessage; selfSelected?: boolean }>,
  ): Promise<void> {
    try {
      const result = await run();
      ctx.post(soulProfileStatusMessage(projectSoulProfileStatus(result.status, { action, selfSelected: result.selfSelected })));
    } catch (error) {
      this.postProfileError(ctx, agent, error);
    }
  }

  private postProfileError(ctx: StudioDomainMessageContext, agent: string, error: unknown): void {
    if (error instanceof SoulError) {
      const safeMessage: Record<string, string> = {
        "soul/profile-adoption-required": "The canonical profile requires explicit digest-backed adoption.",
        "soul/digest-mismatch": "The profile changed; refresh it before trying again.",
        "soul/missing": "The canonical SOUL.md is missing.",
        "soul/outside-workspace": "The canonical profile path is outside the workspace.",
        "soul/final-symlink": "The canonical SOUL.md must be a regular file, not a symlink.",
        "soul/permission-denied": "Permission denied while accessing the selected profile file.",
        "soul/profile-transaction-degraded": "The profile transaction is degraded and blocks further actions.",
        "soul/path-invalid": "The profile action or canonical path is invalid.",
      };
      ctx.post(soulProfileErrorMessage(agent, error.code, safeMessage[error.code] ?? "The profile action could not be completed."));
      return;
    }
    ctx.post(soulProfileErrorMessage(agent, "soul/io-error", "The profile action could not be completed."));
  }
}
