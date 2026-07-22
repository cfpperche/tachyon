/**
 * t-610705 (SDD 410 Phase D, D1b) — Agent Studio's domain-message handler, ported from the retired
 * AgentStudioPanelManager.handleDomainMessage (+ its private soul/evolution helper methods) onto the
 * generic StudioRegistryEntry.handleDomainMessage extension point (studioRegistry.ts). Kept in its
 * own file rather than inline in studioRegistry.ts — this is by far the largest per-studio domain
 * surface (17 message types across soul-profile and Agent Evolution actions), and studioRegistry.ts
 * stays a thin per-studio index (command/terminal's handler is a 3-line browse→cwd forward; this one
 * genuinely needs its own module).
 *
 * The one structural difference from the retired class: `ctx.entityId` (studioHost.ts's
 * StudioMessageHooks, D1b addition) replaces `StudioDomainMessageContext.entityId`
 * (StudioPanelManagerBase's per-panel tracked field) — same value, same "does this message's OWN
 * `agent` field match what's actually bound right now" guard, just sourced from the single active
 * binding instead of a per-panel entry in a Map.
 */
import * as vscode from "vscode";
import type { WorkspaceAgentStudioTarget } from "../shell/WorkspacePresentation.js";
import { SoulError } from "../agents/soul.js";
import { EvolutionStoreError } from "../evolution/EvolutionStore.js";
import { envelope } from "../webview/shared/studio/protocol.js";
import {
  projectSoulProfileStatus,
  validateAgentStudioInboundMessage,
  type SoulProfileStatusMessage,
} from "../webview/agent-studio-shell/domain.js";
import {
  evolutionActionResultMessage,
  evolutionCandidateDetailMessage,
  evolutionCandidatesMessage,
  evolutionErrorMessage,
  evolutionSummaryMessage,
  soulProfileErrorMessage,
  soulProfileStatusMessage,
} from "../webview/agent-studio-shell/messages.js";
import type { StudioDomainContext } from "./studioRegistry.js";

export function handleAgentStudioDomainMessage(ws: WorkspaceAgentStudioTarget, ctx: StudioDomainContext, message: { type: string }): void {
  const m = validateAgentStudioInboundMessage(message);
  if (!m) {
    const type = typeof message.type === "string" ? message.type : "";
    if (type.toLowerCase().includes("evolution")) {
      postEvolutionError(ctx, ctx.entityId ?? "Agent", new Error("Rejected malformed Agent Evolution message"));
    } else {
      postProfileError(ctx, ctx.entityId ?? "Agent", new SoulError("soul/path-invalid", "Rejected malformed Agent Studio profile message"));
    }
    return;
  }
  if (m.type === "browse") {
    void browse(ws, ctx);
    return;
  }
  const agent = ctx.entityId;
  if (!agent || m.agent !== agent) {
    if (m.type.toLowerCase().includes("evolution")) {
      postEvolutionError(ctx, agent ?? "Agent", new Error("Evolution action does not match this saved Agent Studio entity"));
    } else {
      postProfileError(ctx, agent ?? "Agent", new SoulError("soul/path-invalid", "Profile action does not match this saved Agent Studio entity"));
    }
    return;
  }
  if (m.type === "refreshEvolution") { void refreshEvolution(ws, ctx, agent); return; }
  if (m.type === "loadEvolutionCandidate") { void loadEvolutionCandidate(ws, ctx, agent, m.candidateId); return; }
  if (m.type === "approveEvolutionCandidate" || m.type === "rejectEvolutionCandidate") { void resolveEvolutionCandidate(ws, ctx, agent, m); return; }
  if (m.type === "createSoul") { void runProfileAction(ctx, agent, "create", () => ws.createSoulProfile(agent)); return; }
  if (m.type === "importSoul") { void importSoul(ws, ctx, agent, m.contentBase64); return; }
  if (m.type === "replaceSoul") { void replaceSoul(ws, ctx, agent, m.contentBase64, m.expectedDigest); return; }
  if (m.type === "openSoul") { void openSoul(ws, ctx, agent); return; }
  if (m.type === "refreshSoul") { void refreshSoul(ws, ctx, agent, "refresh"); return; }
  if (m.type === "previewSoul") { void refreshSoul(ws, ctx, agent, "preview"); return; }
  if (m.type === "adoptSoulProfile") { void runProfileAction(ctx, agent, "adopt", () => ws.adoptSoulProfile(agent, m.expectedDigest)); return; }
  if (m.type === "enableSoul") { void runProfileAction(ctx, agent, "enable", () => ws.enableSoulProfile(agent)); return; }
  if (m.type === "disableSoul") { void runProfileAction(ctx, agent, "disable", () => ws.disableSoulProfile(agent)); return; }
  if (m.type === "deleteSoulProfile") { void runProfileAction(ctx, agent, "delete", () => ws.deleteSoulProfile(agent)); return; }
}

async function browse(ws: WorkspaceAgentStudioTarget, ctx: StudioDomainContext): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(ws.workspaceRoot),
  });
  if (picked?.[0]) ctx.post(envelope({ type: "cwd" as const, value: picked[0].fsPath }));
}

async function importSoul(ws: WorkspaceAgentStudioTarget, ctx: StudioDomainContext, agent: string, contentBase64: string): Promise<void> {
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.toString("base64") !== contentBase64) {
    postProfileError(ctx, agent, new SoulError("soul/path-invalid", "Rejected malformed Agent Studio import bytes"));
    return;
  }
  await runProfileAction(ctx, agent, "import", () => ws.importSoulProfileBytes(agent, bytes));
}

async function replaceSoul(ws: WorkspaceAgentStudioTarget, ctx: StudioDomainContext, agent: string, contentBase64: string, expectedDigest: string): Promise<void> {
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.toString("base64") !== contentBase64) {
    postProfileError(ctx, agent, new SoulError("soul/path-invalid", "Rejected malformed Agent Studio replacement bytes"));
    return;
  }
  await runProfileAction(ctx, agent, "replace", () => ws.replaceSoulProfileBytes(agent, bytes, expectedDigest));
}

async function openSoul(ws: WorkspaceAgentStudioTarget, ctx: StudioDomainContext, agent: string): Promise<void> {
  try {
    const target = await ws.canonicalSoulPathForOpen(agent);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(doc, { preview: false });
    await refreshSoul(ws, ctx, agent, "open");
  } catch (error) {
    postProfileError(ctx, agent, error);
  }
}

async function refreshSoul(ws: WorkspaceAgentStudioTarget, ctx: StudioDomainContext, agent: string, action: NonNullable<SoulProfileStatusMessage["action"]>): Promise<void> {
  try {
    const status = await ws.refreshSoulProfile(agent);
    ctx.post(soulProfileStatusMessage(projectSoulProfileStatus(status, { action })));
  } catch (error) {
    postProfileError(ctx, agent, error);
  }
}

async function runProfileAction(
  ctx: StudioDomainContext,
  agent: string,
  action: NonNullable<SoulProfileStatusMessage["action"]>,
  run: () => Promise<{ status: SoulProfileStatusMessage; selfSelected?: boolean }>,
): Promise<void> {
  try {
    const result = await run();
    ctx.post(soulProfileStatusMessage(projectSoulProfileStatus(result.status, { action, selfSelected: result.selfSelected })));
  } catch (error) {
    postProfileError(ctx, agent, error);
  }
}

async function refreshEvolution(ws: WorkspaceAgentStudioTarget, ctx: StudioDomainContext, agent: string): Promise<void> {
  try {
    const overview = await ws.readAgentEvolutionOverview(agent);
    ctx.post(evolutionSummaryMessage(overview.summary));
    ctx.post(evolutionCandidatesMessage(agent, overview.candidates));
  } catch (error) {
    postEvolutionError(ctx, agent, error);
  }
}

async function loadEvolutionCandidate(ws: WorkspaceAgentStudioTarget, ctx: StudioDomainContext, agent: string, candidateId: string): Promise<void> {
  try {
    const detail = await ws.readAgentEvolutionCandidate(agent, candidateId);
    ctx.post(evolutionCandidateDetailMessage(agent, detail));
  } catch (error) {
    postEvolutionError(ctx, agent, error);
  }
}

async function resolveEvolutionCandidate(
  ws: WorkspaceAgentStudioTarget,
  ctx: StudioDomainContext,
  agent: string,
  message: { type: "approveEvolutionCandidate" | "rejectEvolutionCandidate"; candidateId: string; expectedActiveVersion: number; expectedTargetDigest?: string },
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
    await refreshEvolution(ws, ctx, agent);
  } catch (error) {
    postEvolutionError(ctx, agent, error);
    if (error instanceof EvolutionStoreError && error.code === "evolution/promotion-conflict") {
      await refreshEvolution(ws, ctx, agent);
    }
  }
}

function postEvolutionError(ctx: StudioDomainContext, agent: string, error: unknown): void {
  const conflict = error instanceof EvolutionStoreError && error.code === "evolution/promotion-conflict";
  const code = error instanceof EvolutionStoreError ? error.code : "evolution/io-error";
  const message = conflict
    ? vscode.l10n.t("This proposal changed or was already reviewed. The latest evolution state was loaded.")
    : vscode.l10n.t("The Agent Evolution action could not be completed.");
  ctx.post(evolutionErrorMessage(agent, code, message, conflict));
}

function postProfileError(ctx: StudioDomainContext, agent: string, error: unknown): void {
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
