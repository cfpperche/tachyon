import * as vscode from "vscode";
import type { WorkspaceAgentStudioTarget } from "../shell/WorkspacePresentation.js";
import { SoulError } from "../agents/soul.js";
import { EvolutionStoreError } from "../evolution/EvolutionStore.js";
import { StudioPanelManagerBase, type StudioDomainMessageContext, type StudioPanelState, type StudioSurfaceConfig } from "./shared/studio/StudioPanelManagerBase.js";
import { envelope, type StudioRestoreSnapshot } from "./shared/studio/protocol.js";
import { AgentStudioAdapter } from "./AgentStudioAdapter.js";
import {
  projectSoulProfileStatus,
  createAgentEvolutionLabels,
  validateAgentStudioInboundMessage,
  type AgentStudioEntity,
  type AgentStudioFields,
  type AgentStudioPatch,
  type SoulProfileStatusMessage,
} from "./agent-studio-shell/domain.js";
import {
  evolutionActionResultMessage,
  evolutionCandidateDetailMessage,
  evolutionCandidatesMessage,
  evolutionErrorMessage,
  evolutionSummaryMessage,
  soulProfileErrorMessage,
  soulProfileStatusMessage,
} from "./agent-studio-shell/messages.js";

/**
 * spec 350 Phase 3 T2 + spec 377 T15A — Agent Studio host wiring.
 * Domain actions: browse/cwd plus typed common-path soul profile protocol.
 * Final Identity UI rendering is T16; this panel owns filesystem-backed actions only.
 */
const surface: StudioSurfaceConfig = {
  viewType: "tachyonAgentStudioShell",
  bundleFile: "agent-studio-shell.js",
  // t-2278bc — KitDropdown needs the shared token bridge + this surface's compiled Tailwind utilities.
  // Keep the standard order: design system → token bridge → Tailwind → surface CSS.
  styleFiles: ["codicon.css", "design-system.css", "vscode-theme.css", "agent-studio-shell.tailwind.css", "studio-frame.css", "agent-studio-shell.css"],
  iconName: "hubot",
};

export const AGENT_STUDIO_SHELL_VIEW_TYPE = surface.viewType;
export type AgentStudioPanelState = StudioPanelState<AgentStudioPatch>;

export class AgentStudioPanelManager {
  private readonly workspaces = new Map<string, StudioPanelManagerBase<AgentStudioEntity, AgentStudioFields, AgentStudioPatch>>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    getWorkspacesOrOnChanged?: (() => WorkspaceAgentStudioTarget[]) | (() => void),
    onChangedMaybe?: () => void,
  ) {
    if (onChangedMaybe) {
      this.getWorkspaces = getWorkspacesOrOnChanged as () => WorkspaceAgentStudioTarget[];
      this.onChanged = onChangedMaybe;
    } else {
      this.getWorkspaces = () => [];
      this.onChanged = (getWorkspacesOrOnChanged as (() => void) | undefined) ?? (() => {});
    }
  }

  private readonly getWorkspaces: () => WorkspaceAgentStudioTarget[];
  private readonly onChanged: () => void;

  openNew(ws: WorkspaceAgentStudioTarget): void {
    this.baseFor(ws).openNew(ws.wsHash);
  }

  openExisting(ws: WorkspaceAgentStudioTarget, agentName: string): void {
    this.baseFor(ws).openExisting(ws.wsHash, agentName);
  }

  refreshAll(): void {
    for (const base of this.workspaces.values()) base.refreshAll();
  }

  dispose(): void {
    for (const base of this.workspaces.values()) base.dispose();
    this.workspaces.clear();
  }

  captureSnapshot(ws: WorkspaceAgentStudioTarget, entityId?: string): StudioRestoreSnapshot<string, AgentStudioPatch> | undefined {
    return this.workspaces.get(ws.wsHash)?.captureSnapshot(ws.wsHash, entityId);
  }

  restoreFromSnapshot(ws: WorkspaceAgentStudioTarget, snapshot: StudioRestoreSnapshot<string, AgentStudioPatch>): void {
    this.baseFor(ws).restoreFromSnapshot(ws.wsHash, snapshot);
  }

  deserialize(panel: vscode.WebviewPanel, state: AgentStudioPanelState): void {
    const ws = this.getWorkspaces().find((w) => w.wsHash === state.wsKey);
    if (!ws) { panel.dispose(); return; }
    this.baseFor(ws).deserializePanel(panel, state);
  }

  private baseFor(ws: WorkspaceAgentStudioTarget): StudioPanelManagerBase<AgentStudioEntity, AgentStudioFields, AgentStudioPatch> {
    let base = this.workspaces.get(ws.wsHash);
    if (!base) {
      base = new StudioPanelManagerBase<AgentStudioEntity, AgentStudioFields, AgentStudioPatch>(
        this.extensionUri,
        surface,
        new AgentStudioAdapter(
          ws,
          createAgentEvolutionLabels((message, ...args) => vscode.l10n.t(message, ...args)),
          vscode.l10n.t("When supported, delivered at startup through the selected runtime."),
        ),
        this.onChanged,
        (ctx, message) => this.handleDomainMessage(ws, ctx, message),
      );
      this.workspaces.set(ws.wsHash, base);
    }
    return base;
  }

  private handleDomainMessage(ws: WorkspaceAgentStudioTarget, ctx: StudioDomainMessageContext, message: { type: string }): void {
    const m = validateAgentStudioInboundMessage(message);
    if (!m) {
      const type = typeof message.type === "string" ? message.type : "";
      if (type.toLowerCase().includes("evolution")) {
        this.postEvolutionError(ctx, ctx.entityId ?? "Agent", new Error("Rejected malformed Agent Evolution message"));
      } else {
        this.postProfileError(ctx, ctx.entityId ?? "Agent", new SoulError("soul/path-invalid", "Rejected malformed Agent Studio profile message"));
      }
      return;
    }
    if (m.type === "browse") {
      void this.browse(ws, ctx);
      return;
    }
    const agent = ctx.entityId;
    if (!agent || m.agent !== agent) {
      if (m.type.toLowerCase().includes("evolution")) {
        this.postEvolutionError(ctx, agent ?? "Agent", new Error("Evolution action does not match this saved Agent Studio entity"));
      } else {
        this.postProfileError(ctx, agent ?? "Agent", new SoulError("soul/path-invalid", "Profile action does not match this saved Agent Studio entity"));
      }
      return;
    }
    if (m.type === "refreshEvolution") { void this.refreshEvolution(ws, ctx, agent); return; }
    if (m.type === "loadEvolutionCandidate") {
      void this.loadEvolutionCandidate(ws, ctx, agent, m.candidateId);
      return;
    }
    if (m.type === "approveEvolutionCandidate" || m.type === "rejectEvolutionCandidate") {
      void this.resolveEvolutionCandidate(ws, ctx, agent, m);
      return;
    }
    if (m.type === "createSoul") { void this.runProfileAction(ws, ctx, agent, "create", () => ws.createSoulProfile(agent)); return; }
    if (m.type === "importSoul") { void this.importSoul(ws, ctx, agent, m.contentBase64); return; }
    if (m.type === "replaceSoul") { void this.replaceSoul(ws, ctx, agent, m.contentBase64, m.expectedDigest); return; }
    if (m.type === "openSoul") { void this.openSoul(ws, ctx, agent); return; }
    if (m.type === "refreshSoul") { void this.refreshSoul(ws, ctx, agent, "refresh"); return; }
    if (m.type === "previewSoul") { void this.refreshSoul(ws, ctx, agent, "preview"); return; }
    if (m.type === "adoptSoulProfile") {
      void this.runProfileAction(ws, ctx, agent, "adopt", () => ws.adoptSoulProfile(agent, m.expectedDigest));
      return;
    }
    if (m.type === "enableSoul") { void this.runProfileAction(ws, ctx, agent, "enable", () => ws.enableSoulProfile(agent)); return; }
    if (m.type === "disableSoul") { void this.runProfileAction(ws, ctx, agent, "disable", () => ws.disableSoulProfile(agent)); return; }
    if (m.type === "deleteSoulProfile") { void this.runProfileAction(ws, ctx, agent, "delete", () => ws.deleteSoulProfile(agent)); return; }
  }

  private async browse(ws: WorkspaceAgentStudioTarget, ctx: StudioDomainMessageContext): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(ws.workspaceRoot),
    });
    if (picked?.[0]) ctx.post(envelope({ type: "cwd" as const, value: picked[0].fsPath }));
  }

  private async importSoul(ws: WorkspaceAgentStudioTarget, ctx: StudioDomainMessageContext, agent: string, contentBase64: string): Promise<void> {
    const bytes = Buffer.from(contentBase64, "base64");
    if (bytes.toString("base64") !== contentBase64) {
      this.postProfileError(ctx, agent, new SoulError("soul/path-invalid", "Rejected malformed Agent Studio import bytes"));
      return;
    }
    await this.runProfileAction(ws, ctx, agent, "import", () => ws.importSoulProfileBytes(agent, bytes));
  }

  private async replaceSoul(
    ws: WorkspaceAgentStudioTarget,
    ctx: StudioDomainMessageContext,
    agent: string,
    contentBase64: string,
    expectedDigest: string,
  ): Promise<void> {
    const bytes = Buffer.from(contentBase64, "base64");
    if (bytes.toString("base64") !== contentBase64) {
      this.postProfileError(ctx, agent, new SoulError("soul/path-invalid", "Rejected malformed Agent Studio replacement bytes"));
      return;
    }
    await this.runProfileAction(ws, ctx, agent, "replace", () => ws.replaceSoulProfileBytes(agent, bytes, expectedDigest));
  }

  private async openSoul(ws: WorkspaceAgentStudioTarget, ctx: StudioDomainMessageContext, agent: string): Promise<void> {
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
    ws: WorkspaceAgentStudioTarget,
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
    _ws: WorkspaceAgentStudioTarget,
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

  private async refreshEvolution(
    ws: WorkspaceAgentStudioTarget,
    ctx: StudioDomainMessageContext,
    agent: string,
  ): Promise<void> {
    try {
      const overview = await ws.readAgentEvolutionOverview(agent);
      ctx.post(evolutionSummaryMessage(overview.summary));
      ctx.post(evolutionCandidatesMessage(agent, overview.candidates));
    } catch (error) {
      this.postEvolutionError(ctx, agent, error);
    }
  }

  private async loadEvolutionCandidate(
    ws: WorkspaceAgentStudioTarget,
    ctx: StudioDomainMessageContext,
    agent: string,
    candidateId: string,
  ): Promise<void> {
    try {
      const detail = await ws.readAgentEvolutionCandidate(agent, candidateId);
      ctx.post(evolutionCandidateDetailMessage(agent, detail));
    } catch (error) {
      this.postEvolutionError(ctx, agent, error);
    }
  }

  private async resolveEvolutionCandidate(
    ws: WorkspaceAgentStudioTarget,
    ctx: StudioDomainMessageContext,
    agent: string,
    message: {
      type: "approveEvolutionCandidate" | "rejectEvolutionCandidate";
      candidateId: string;
      expectedActiveVersion: number;
      expectedTargetDigest?: string;
    },
  ): Promise<void> {
    const input = {
      expectedActiveVersion: message.expectedActiveVersion,
      ...(message.expectedTargetDigest !== undefined ? { expectedTargetDigest: message.expectedTargetDigest } : {}),
    };
    try {
      const result = message.type === "approveEvolutionCandidate"
        ? await ws.approveAgentEvolutionCandidate(agent, message.candidateId, input)
        : await ws.rejectAgentEvolutionCandidate(agent, message.candidateId, input);
      ctx.post(evolutionActionResultMessage(
        agent,
        result.candidateId,
        message.type === "approveEvolutionCandidate" ? "approved" : "rejected",
        result.activeVersion,
      ));
      await this.refreshEvolution(ws, ctx, agent);
    } catch (error) {
      this.postEvolutionError(ctx, agent, error);
      if (error instanceof EvolutionStoreError && error.code === "evolution/promotion-conflict") {
        await this.refreshEvolution(ws, ctx, agent);
      }
    }
  }

  private postEvolutionError(ctx: StudioDomainMessageContext, agent: string, error: unknown): void {
    const conflict = error instanceof EvolutionStoreError && error.code === "evolution/promotion-conflict";
    const code = error instanceof EvolutionStoreError ? error.code : "evolution/io-error";
    const message = conflict
      ? vscode.l10n.t("This proposal changed or was already reviewed. The latest evolution state was loaded.")
      : vscode.l10n.t("The Agent Evolution action could not be completed.");
    ctx.post(evolutionErrorMessage(agent, code, message, conflict));
  }

  private postProfileError(ctx: StudioDomainMessageContext, agent: string, error: unknown): void {
    if (error instanceof SoulError) {
      const safeMessage: Record<string, string> = {
        "soul/profile-adoption-required": "This identity is not enabled yet. Refresh and choose Enable Soul.",
        "soul/digest-mismatch": "The profile changed; refresh it before trying again.",
        "soul/missing": "The canonical SOUL.md is missing.",
        "soul/outside-workspace": "The canonical profile path is outside the workspace.",
        "soul/final-symlink": "The canonical SOUL.md must be a regular file, not a symlink.",
        "soul/permission-denied": "Permission denied while accessing the selected profile file.",
        "soul/profile-transaction-degraded": "The profile transaction is degraded and blocks further actions.",
        "soul/profile-enabled": "Disable Soul before permanently deleting its identity files.",
        "soul/path-invalid": "The profile action or canonical path is invalid.",
      };
      ctx.post(soulProfileErrorMessage(agent, error.code, safeMessage[error.code] ?? "The profile action could not be completed."));
      return;
    }
    ctx.post(soulProfileErrorMessage(agent, "soul/io-error", "The profile action could not be completed."));
  }
}
