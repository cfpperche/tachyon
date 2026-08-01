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
import { AGENT_PROFILE_REVISION_CONFLICT_CODE } from "../config/agentProfileRefusal.js";
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
  agentProfileErrorMessage,
  authorizableCapabilitiesMessage,
  agentProfileForgottenMessage,
  agentProfileOwnershipMessage,
  agentProfileSnapshotMessage,
  agentProfileBundleCreatedMessage,
  agentProfileBundleErrorMessage,
  agentProfileBundleExportMessage,
  soulProfileErrorMessage,
  soulProfileStatusMessage,
} from "../webview/agent-studio-shell/messages.js";
import type { StudioDomainContext } from "./studioRegistry.js";

export function handleAgentStudioDomainMessage(ws: WorkspaceAgentStudioTarget, ctx: StudioDomainContext, message: { type: string }): void {
  const m = validateAgentStudioInboundMessage(message);
  if (!m) {
    const type = typeof message.type === "string" ? message.type : "";
    if (type.toLowerCase().includes("agentprofile")) {
      postAgentProfileError(ctx, ctx.entityId ?? "Agent", new Error("Rejected malformed canonical profile message"));
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
    if (m.type.toLowerCase().includes("agentprofile")) {
      postAgentProfileError(ctx, agent ?? "Agent", new Error("Canonical profile action does not match this Agent Studio entity"));
    } else if (m.type.toLowerCase().includes("evolution")) {
      postEvolutionError(ctx, agent ?? "Agent", new Error("Evolution action does not match this saved Agent Studio entity"));
    } else {
      postProfileError(ctx, agent ?? "Agent", new SoulError("soul/path-invalid", "Profile action does not match this saved Agent Studio entity"));
    }
    return;
  }
  if (m.type === "refreshAgentProfile") { void refreshAgentProfile(ws, ctx, agent); return; }
  if (m.type === "exportSavedAgentProfileBundle") { void runBundleAction(ws, ctx, agent, () => ws.exportAgentProfileStudioBundle(agent, m.expectedRevision)); return; }
  if (m.type === "cloneSavedAgentProfileBundle") { void runBundleAction(ws, ctx, agent, () => ws.cloneAgentProfileStudioBundle(agent, m.expectedRevision, m.destinationAgentName)); return; }
  if (m.type === "importSavedAgentProfileBundle") {
    const bytes = Buffer.from(m.contentBase64, "base64");
    if (bytes.toString("base64") !== m.contentBase64) { postBundleError(ctx, agent, new Error("invalid bundle bytes")); return; }
    void runBundleAction(ws, ctx, agent, () => ws.importAgentProfileStudioBundle(m.destinationAgentName, bytes));
    return;
  }
  if (m.type === "setAgentProfileEnabled") {
    void runAgentProfileAction(ws, ctx, {
      schemaVersion: 1,
      operation: "set-enabled",
      agentName: agent,
      expectedRevision: m.expectedRevision,
      enabled: m.enabled,
    });
    return;
  }
  if (m.type === "renameAgentProfile") {
    void runAgentProfileAction(ws, ctx, {
      schemaVersion: 1,
      operation: "rename",
      agentName: agent,
      expectedRevision: m.expectedRevision,
      newName: m.newName,
    });
    return;
  }
  if (m.type === "setAgentProfileSubagents") {
    void runAgentProfileAction(ws, ctx, {
      schemaVersion: 1,
      operation: "set-subagents",
      agentName: agent,
      expectedRevision: m.expectedRevision,
      subagents: [...m.subagents],
    });
    return;
  }
  if (m.type === "setAgentProfileProposeGrant") {
    void runAgentProfileAction(ws, ctx, {
      schemaVersion: 1,
      operation: "set-propose-saved-agent-grant",
      agentName: agent,
      expectedRevision: m.expectedRevision,
      granted: m.granted,
    });
    return;
  }
  if (m.type === "forgetAgentProfile") {
    void runAgentProfileAction(ws, ctx, {
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
  if (m.type === "authorizeSkill") { void authorizeSkill(ws, ctx, agent, m.skillName, m.reauthorize); return; }
  if (m.type === "authorizePlugin") { void authorizePlugin(ws, ctx, agent, m.pluginName, m.reauthorize); return; }
  if (m.type === "refreshAuthorizableCapabilities") { void refreshCandidates(ws, ctx, agent); return; }
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
    if ("contentBase64" in result) ctx.post(agentProfileBundleExportMessage(result));
    else ctx.post(agentProfileBundleCreatedMessage(result));
  } catch (error) {
    postBundleError(ctx, agent, error);
    if (isBundleRevisionConflict(error)) await refreshAgentProfile(ws, ctx, agent);
  }
}

/**
 * The LAST substring reader on this file, kept deliberately and named for the one surface it still
 * serves: portable bundle export/clone.
 *
 * t-05dff5 removed the lifecycle copy of this because it was silently swallowing forget's refusals.
 * The bundle surface has no such refusals to lose — `exportAgentProfileStudioBundle` and
 * `cloneAgentProfileStudioBundle` return raw bytes and an import result, not a discriminated
 * outcome, so there is no success channel a refusal could travel on and nothing but a stale revision
 * to detect. Giving those two calls a `refused` outcome the way the lifecycle call now has one is the
 * fix; until then this stays narrow, and its narrowness is the point — it decides ONLY whether to
 * reload, never whether an engine sentence may be shown.
 */
function isBundleRevisionConflict(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("revision")
    && (error.message.toLowerCase().includes("conflict") || error.message.toLowerCase().includes("changed"));
}

function postBundleError(ctx: StudioDomainContext, agent: string, error: unknown): void {
  const conflict = isBundleRevisionConflict(error);
  ctx.post(agentProfileBundleErrorMessage(agent, conflict ? "agent-profile/revision-conflict" : "agent-profile/bundle-failed", conflict
    ? "This profile changed. The latest profile was loaded; review it before trying again."
    : "The portable profile action could not be completed.", conflict));
}

/**
 * t-5498a6 — authorize one workspace skill, then refresh so the profile answers for itself.
 *
 * The refresh IS the success signal: a newly authorized skill appears as a checkbox in Runtime
 * tooling, unticked. That is the honest render of what happened — the profile may now select it and
 * has not. A separate "authorized!" toast would claim the same thing while the list still showed
 * nothing, which is how a UI ends up disagreeing with the state it is displaying.
 *
 * A refusal ("this plugin does not install for codex") arrives as a VALUE, not an exception, so it
 * reaches the human as itself rather than as a generic save failure.
 */
async function authorizeSkill(
  ws: WorkspaceAgentStudioTarget,
  ctx: StudioDomainContext,
  agent: string,
  skillName: string,
  reauthorize: boolean,
): Promise<void> {
  try {
    const result = await ws.authorizeAgentSkill(agent, skillName, { reauthorize });
    // t-4a2a6f — `digest-changed` is `ok: true` and writes NOTHING. Treating it as success is how the
    // screen came to report a repair it never performed. It reaches the human as a refusal naming the
    // gesture that resolves it, because that is what it is: a decision handed back, not a failure.
    if (result.ok && result.outcome === "digest-changed") {
      ctx.post(agentProfileErrorMessage(
        agent,
        "agent-profile/skill-authorization-refused",
        `skill '${skillName}' was authorized at content that has since changed — nothing was written. Use Reauthorize to accept the new content.`,
        false,
      ));
      await refreshCandidates(ws, ctx, agent);
      return;
    }
    if (!result.ok) {
      // Posted DIRECTLY rather than through `postAgentProfileError`, which flattens every message to
      // "the profile lifecycle action could not be completed". That sanitising is right for an
      // internal failure and wrong here: this text is the ANSWER — which plugin, which runtime, why —
      // and returning it as a value only to discard it at the last hop would leave the human staring
      // at a button that does nothing for no stated reason.
      ctx.post(agentProfileErrorMessage(agent, "agent-profile/skill-authorization-refused", result.error, false));
      return;
    }
    await refreshAgentProfile(ws, ctx, agent);
    await refreshCandidates(ws, ctx, agent);
  } catch (error) {
    postAgentProfileError(ctx, agent, error);
  }
}

/**
 * t-5498a6 — authorize everything a plugin exposes for this runtime.
 *
 * The all-or-nothing rule is enforced one layer down: a plugin that also installs a `settings-hook`
 * or a `view` is refused WHOLE, because authorizing only its skills would report success while half
 * the plugin never reached the agent.
 */
async function authorizePlugin(
  ws: WorkspaceAgentStudioTarget,
  ctx: StudioDomainContext,
  agent: string,
  pluginName: string,
  reauthorize: boolean,
): Promise<void> {
  try {
    const result = await ws.authorizeAgentPlugin(agent, pluginName, { reauthorize });
    if (!result.ok) {
      ctx.post(agentProfileErrorMessage(agent, "agent-profile/skill-authorization-refused", result.error, false));
      return;
    }
    // t-4a2a6f — same rule as the skill door, and it matters more here: a plugin authorizes several
    // skills, so a partial `digest-changed` means some landed and some did not. Naming the ones that
    // did not is the only way the human can tell a finished repair from a half one.
    const stale = result.authorized.filter((_, index) => result.outcomes[index] === "digest-changed");
    if (stale.length > 0) {
      ctx.post(agentProfileErrorMessage(
        agent,
        "agent-profile/skill-authorization-refused",
        `plugin '${pluginName}': ${stale.join(", ")} ${stale.length === 1 ? "was" : "were"} authorized at content that has since changed — nothing was written for ${stale.length === 1 ? "it" : "them"}. Use Reauthorize to accept the new content.`,
        false,
      ));
    }
    await refreshAgentProfile(ws, ctx, agent);
    await refreshCandidates(ws, ctx, agent);
  } catch (error) {
    postAgentProfileError(ctx, agent, error);
  }
}

/** t-5498a6 — candidate lists, re-queried after every authorization so the two selectors shrink. */
async function refreshCandidates(
  ws: WorkspaceAgentStudioTarget,
  ctx: StudioDomainContext,
  agent: string,
): Promise<void> {
  try {
    ctx.post(authorizableCapabilitiesMessage(agent, await ws.authorizableCapabilitiesFor(agent)));
  } catch (error) {
    postAgentProfileError(ctx, agent, error);
  }
}

async function refreshAgentProfile(ws: WorkspaceAgentStudioTarget, ctx: StudioDomainContext, agent: string): Promise<void> {
  try {
    ctx.post(agentProfileSnapshotMessage("refresh", await ws.inspectAgentProfileStudio(agent)));
    await postOwnership(ws, ctx, agent);
  } catch (error) {
    postAgentProfileError(ctx, agent, error);
  }
}

/**
 * t-4c113c — declared ownership travels beside the snapshot rather than inside it. The snapshot is
 * an engine↔shell payload with an exact protocol version, and widening it would make a current
 * engine undecodable to the previous shell (the 0.56.110 D1 failure); this message never leaves the
 * extension↔webview pair, which always ships as one bundle.
 */
async function postOwnership(ws: WorkspaceAgentStudioTarget, ctx: StudioDomainContext, agent: string): Promise<void> {
  ctx.post(agentProfileOwnershipMessage(agent, await ws.agentOwnershipView(agent)));
}

async function runAgentProfileAction(
  ws: WorkspaceAgentStudioTarget,
  ctx: StudioDomainContext,
  mutation: Parameters<WorkspaceAgentStudioTarget["commitAgentProfileStudioLifecycle"]>[0],
): Promise<void> {
  try {
    const result = await ws.commitAgentProfileStudioLifecycle(mutation);
    if (result.kind === "refused") {
      // t-05dff5 — the engine's own sentence, posted DIRECTLY, on the same reasoning the skill door
      // above already wrote down: this text is the ANSWER. "still owns a worktree; remove it
      // explicitly before canonical forget" names the gesture that unblocks the human, and routing it
      // through `postAgentProfileError` would replace it with a button that does nothing for no
      // stated reason. It is safe to show BECAUSE it arrived as a refusal — a value the engine
      // deliberately addressed to a reader — and not because of anything it happens to say.
      // A revision conflict is the one refusal the SHELL resolves rather than the human, so it is the
      // one whose sentence the shell owns: it reloads the profile and then says so. Deferring to the
      // engine's "agent 'Ada' profile revision conflict" here would describe the condition and hide
      // the recovery that already happened — and would forward engine prose that, unlike forget's,
      // has carried absolute paths. Every other refusal names a gesture only the human can perform,
      // so its own words go through and no refresh is issued; redrawing would show the same block.
      if (result.code === AGENT_PROFILE_REVISION_CONFLICT_CODE) {
        ctx.post(agentProfileErrorMessage(
          mutation.agentName,
          result.code,
          "This profile changed. The latest profile was loaded; review it before trying again.",
          true,
        ));
        await refreshAgentProfile(ws, ctx, mutation.agentName);
        return;
      }
      ctx.post(agentProfileErrorMessage(mutation.agentName, result.code, result.message, false));
      return;
    }
    if (result.kind === "forgotten") {
      ctx.post(agentProfileForgottenMessage(result.agentName, result.agentId));
      return;
    }
    ctx.post(agentProfileSnapshotMessage(mutation.operation === "forget" ? "refresh" : mutation.operation, result.snapshot));
    if (mutation.operation === "set-subagents") await postOwnership(ws, ctx, mutation.agentName);
  } catch (error) {
    postAgentProfileError(ctx, mutation.agentName, error);
  }
}

/**
 * The internal-failure sentence, and now ONLY that.
 *
 * It used to also classify: `message.includes("revision")` decided whether an exception was a
 * conflict, which put the decision in a READER of free prose rather than in the author of the
 * condition, and let every refusal that did not happen to say "revision" — all of forget's — be
 * flattened away (t-05dff5). Refusals no longer arrive here at all; they arrive as
 * `kind: "refused"` values above. What reaches this function is a broken transaction, and one
 * neutral sentence is the correct thing to say about a stack, a path or an EIO.
 *
 * `_error` is kept, deliberately unread, so every call site still states at the throw what went
 * wrong for whoever reads the source or a future log sink — the panel just never repeats it.
 */
function postAgentProfileError(ctx: StudioDomainContext, agent: string, _error: unknown): void {
  ctx.post(agentProfileErrorMessage(
    agent,
    "agent-profile/lifecycle-failed",
    "The profile lifecycle action could not be completed.",
    false,
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
