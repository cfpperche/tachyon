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
  canonicalProfileErrorMessage,
  canonicalProfileForgottenMessage,
  canonicalProfileOwnershipMessage,
  canonicalProfileSnapshotMessage,
  canonicalProfileBundleCreatedMessage,
  canonicalProfileBundleErrorMessage,
  canonicalProfileBundleExportMessage,
  soulProfileErrorMessage,
  soulProfileStatusMessage,
} from "../webview/agent-studio-shell/messages.js";
import type { StudioDomainContext } from "./studioRegistry.js";

export function handleAgentStudioDomainMessage(ws: WorkspaceAgentStudioTarget, ctx: StudioDomainContext, message: { type: string }): void {
  const m = validateAgentStudioInboundMessage(message);
  if (!m) {
    const type = typeof message.type === "string" ? message.type : "";
    if (type.toLowerCase().includes("canonicalprofile")) {
      postCanonicalProfileError(ctx, ctx.entityId ?? "Agent", new Error("Rejected malformed canonical profile message"));
    } else if (type.toLowerCase().includes("evolution")) {
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
    if (m.type.toLowerCase().includes("canonicalprofile")) {
      postCanonicalProfileError(ctx, agent ?? "Agent", new Error("Canonical profile action does not match this Agent Studio entity"));
    } else if (m.type.toLowerCase().includes("evolution")) {
      postEvolutionError(ctx, agent ?? "Agent", new Error("Evolution action does not match this saved Agent Studio entity"));
    } else {
      postProfileError(ctx, agent ?? "Agent", new SoulError("soul/path-invalid", "Profile action does not match this saved Agent Studio entity"));
    }
    return;
  }
  if (m.type === "refreshCanonicalProfile") { void refreshCanonicalProfile(ws, ctx, agent); return; }
  if (m.type === "exportCanonicalProfileBundle") { void runBundleAction(ws, ctx, agent, () => ws.exportAgentProfileStudioBundle(agent, m.expectedRevision)); return; }
  if (m.type === "cloneCanonicalProfileBundle") { void runBundleAction(ws, ctx, agent, () => ws.cloneAgentProfileStudioBundle(agent, m.expectedRevision, m.destinationAgentName)); return; }
  if (m.type === "importCanonicalProfileBundle") {
    const bytes = Buffer.from(m.contentBase64, "base64");
    if (bytes.toString("base64") !== m.contentBase64) { postBundleError(ctx, agent, new Error("invalid bundle bytes")); return; }
    void runBundleAction(ws, ctx, agent, () => ws.importAgentProfileStudioBundle(m.destinationAgentName, bytes));
    return;
  }
  if (m.type === "setCanonicalProfileEnabled") {
    void runCanonicalProfileAction(ws, ctx, {
      schemaVersion: 1,
      operation: "set-enabled",
      agentName: agent,
      expectedRevision: m.expectedRevision,
      enabled: m.enabled,
    });
    return;
  }
  if (m.type === "renameCanonicalProfile") {
    void runCanonicalProfileAction(ws, ctx, {
      schemaVersion: 1,
      operation: "rename",
      agentName: agent,
      expectedRevision: m.expectedRevision,
      newName: m.newName,
    });
    return;
  }
  if (m.type === "setCanonicalProfileSubagents") {
    void runCanonicalProfileAction(ws, ctx, {
      schemaVersion: 1,
      operation: "set-subagents",
      agentName: agent,
      expectedRevision: m.expectedRevision,
      subagents: [...m.subagents],
    });
    return;
  }
  if (m.type === "setCanonicalProfileProposeGrant") {
    void runCanonicalProfileAction(ws, ctx, {
      schemaVersion: 1,
      operation: "set-propose-saved-agent-grant",
      agentName: agent,
      expectedRevision: m.expectedRevision,
      granted: m.granted,
    });
    return;
  }
  if (m.type === "forgetCanonicalProfile") {
    void runCanonicalProfileAction(ws, ctx, {
      schemaVersion: 1,
      operation: "forget",
      agentName: agent,
      expectedRevision: m.expectedRevision,
      confirmation: m.confirmation,
    });
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

async function runBundleAction(
  ws: WorkspaceAgentStudioTarget,
  ctx: StudioDomainContext,
  agent: string,
  run: () => Promise<Awaited<ReturnType<WorkspaceAgentStudioTarget["exportAgentProfileStudioBundle"]>> | Awaited<ReturnType<WorkspaceAgentStudioTarget["cloneAgentProfileStudioBundle"]>>>,
): Promise<void> {
  try {
    const result = await run();
    if ("contentBase64" in result) ctx.post(canonicalProfileBundleExportMessage(result));
    else ctx.post(canonicalProfileBundleCreatedMessage(result));
  } catch (error) {
    postBundleError(ctx, agent, error);
    if (isRevisionConflict(error)) await refreshCanonicalProfile(ws, ctx, agent);
  }
}

function postBundleError(ctx: StudioDomainContext, agent: string, error: unknown): void {
  const conflict = isRevisionConflict(error);
  ctx.post(canonicalProfileBundleErrorMessage(agent, conflict ? "agent-profile/revision-conflict" : "agent-profile/bundle-failed", conflict
    ? "This profile changed. The latest profile was loaded; review it before trying again."
    : "The portable profile action could not be completed.", conflict));
}

async function refreshCanonicalProfile(ws: WorkspaceAgentStudioTarget, ctx: StudioDomainContext, agent: string): Promise<void> {
  try {
    ctx.post(canonicalProfileSnapshotMessage("refresh", await ws.inspectAgentProfileStudio(agent)));
    await postOwnership(ws, ctx, agent);
  } catch (error) {
    postCanonicalProfileError(ctx, agent, error);
  }
}

/**
 * t-4c113c — declared ownership travels beside the snapshot rather than inside it. The snapshot is
 * an engine↔shell payload with an exact protocol version, and widening it would make a current
 * engine undecodable to the previous shell (the 0.56.110 D1 failure); this message never leaves the
 * extension↔webview pair, which always ships as one bundle.
 */
async function postOwnership(ws: WorkspaceAgentStudioTarget, ctx: StudioDomainContext, agent: string): Promise<void> {
  ctx.post(canonicalProfileOwnershipMessage(agent, await ws.agentOwnershipView(agent)));
}

async function runCanonicalProfileAction(
  ws: WorkspaceAgentStudioTarget,
  ctx: StudioDomainContext,
  mutation: Parameters<WorkspaceAgentStudioTarget["commitAgentProfileStudioLifecycle"]>[0],
): Promise<void> {
  try {
    const result = await ws.commitAgentProfileStudioLifecycle(mutation);
    if (result.kind === "forgotten") {
      ctx.post(canonicalProfileForgottenMessage(result.agentName, result.agentId));
      return;
    }
    ctx.post(canonicalProfileSnapshotMessage(mutation.operation === "forget" ? "refresh" : mutation.operation, result.snapshot));
    if (mutation.operation === "set-subagents") await postOwnership(ws, ctx, mutation.agentName);
  } catch (error) {
    postCanonicalProfileError(ctx, mutation.agentName, error);
    if (isRevisionConflict(error)) await refreshCanonicalProfile(ws, ctx, mutation.agentName);
  }
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("revision")
    && (error.message.toLowerCase().includes("conflict") || error.message.toLowerCase().includes("changed"));
}

function postCanonicalProfileError(ctx: StudioDomainContext, agent: string, error: unknown): void {
  const conflict = isRevisionConflict(error);
  ctx.post(canonicalProfileErrorMessage(
    agent,
    conflict ? "agent-profile/revision-conflict" : "agent-profile/lifecycle-failed",
    conflict
      ? "This profile changed. The latest profile was loaded; review it before trying again."
      : "The profile lifecycle action could not be completed.",
    conflict,
  ));
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
