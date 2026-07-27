import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SoulError, isSoulErrorCode } from "../agents/soul.js";
import {
  asAgent,
  CONFIG_FILENAMES,
  suggestKindForCommand,
  type TachyonConfig,
} from "../config/loadConfig.js";
import { parseProfileAwareConfigSyntax } from "../config/agentProfileConfigLoader.js";
import { scanAgentProfilePointers } from "../config/agentProfilePointer.js";
import { collectVerifyCandidates } from "../config/verifyCandidates.js";
import { detectInstalledClis } from "../webview/cliDetect.js";
import type { StudioDeps, StudioSubmit } from "../webview/studioSubmit.js";
import {
  isSoulProfileStatusMessage,
  projectSoulProfileStatus,
  validateAgentStudioHostDomainMessage,
} from "../webview/agent-studio-shell/domain.js";
import { EvolutionStoreError, type EvolutionStoreErrorCode } from "../evolution/EvolutionStore.js";
import type {
  EvolutionStudioCandidateDetail,
  EvolutionStudioOverview,
} from "../evolution/studioProjection.js";
import type { ExtensionCommandV1, JsonValue } from "../runtime-api/extensionOperations.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import type {
  SoulProfileMutationTargetResult,
  WorkspaceAgentStudioTarget,
} from "./WorkspacePresentation.js";
import {
  isAgentProfileStudioSnapshotV1,
  agentProfileStudioLifecycleResultSchemaV1,
  agentProfileStudioBundleCreatedResultSchemaV1,
  agentProfileStudioBundleExportResultSchemaV1,
  type AgentProfileStudioBundleCreatedResultV1,
  type AgentProfileStudioBundleExportResultV1,
  type AgentProfileStudioLifecycleMutationV1,
  type AgentProfileStudioLifecycleResultV1,
  type AgentProfileStudioMutationV1,
  type AgentProfileStudioSnapshotV1,
} from "../config/agentProfileStudio.js";

type SoulProfileCommand = Extract<ExtensionCommandV1, {
  action:
    | "soul.profile.create"
    | "soul.profile.import"
    | "soul.profile.replace"
    | "soul.profile.adopt"
    | "soul.profile.enable"
    | "soul.profile.disable"
    | "soul.profile.delete";
}>;

export interface ClientWorkspaceStudioTargetOptions {
  extensionUri: StudioDeps["extensionUri"];
  detectClis?: StudioDeps["detectClis"];
  readConfig?: (workspaceRoot: string) => WorkspaceConfigReadResult;
  operationId?: () => string;
}

export type WorkspaceConfigReadResult =
  | { status: "valid"; config: TachyonConfig }
  | { status: "invalid" }
  | { status: "missing" };

/**
 * Editor-side Studio target backed by a persistent WorkspaceClient. It may read
 * the shared config for form population, but every mutation crosses the
 * authenticated engine command seam and executes Workspace.studioSubmit there.
 */
export class ClientWorkspaceStudioTarget implements WorkspaceAgentStudioTarget {
  private readonly detectClis: StudioDeps["detectClis"];
  private readonly readCurrentConfig: (workspaceRoot: string) => WorkspaceConfigReadResult;
  private readonly operationId: () => string;
  private lastGoodConfig: TachyonConfig | undefined;

  constructor(
    private readonly client: WorkspaceClient,
    private readonly options: ClientWorkspaceStudioTargetOptions,
  ) {
    this.detectClis = options.detectClis ?? detectInstalledClis;
    this.readCurrentConfig = options.readConfig ?? readWorkspaceConfig;
    this.operationId = options.operationId ?? randomUUID;
    this.refreshConfig();
  }

  get workspaceRoot(): string { return this.client.workspaceRoot; }
  get wsHash(): string { return this.client.workspaceHash; }
  get folderName(): string { return this.client.presentation.workspace.folderName; }

  get config(): TachyonConfig | undefined {
    return this.refreshConfig();
  }

  studioDeps(): StudioDeps {
    return {
      extensionUri: this.options.extensionUri,
      detectClis: this.detectClis,
      takenNames: () => Object.keys(this.config?.agents ?? {}),
      commandNames: () => Object.keys(this.config?.commands ?? {}),
      verifyCandidates: () => collectVerifyCandidates(this.workspaceRoot, this.config),
      defaultCwd: this.workspaceRoot,
      suggestKindForCommand,
      onSubmit: this.studioSubmit,
    };
  }

  studioSubmit = async (submit: StudioSubmit): Promise<string[] | undefined> => {
    const result = await this.client.invoke(this.operationId(), {
      schemaVersion: 1,
      method: "studio.submit",
      input: {
        state: submit.state,
        ...(submit.editingName !== undefined ? { editingName: submit.editingName } : {}),
      },
    });
    if (result.method !== "studio.submit") {
      throw new Error("persistent engine returned a mismatched Studio command result");
    }
    if (result.status === "error") throw new Error(result.message);
    if (result.errors.length > 0) {
      return result.truncated
        ? [...result.errors, "Additional Studio validation errors were omitted by the engine"]
        : result.errors;
    }
    this.refreshConfig();
    return undefined;
  };

  async inspectAgentProfileStudio(agent: string): Promise<AgentProfileStudioSnapshotV1> {
    const result = await this.client.query({
      schemaVersion: 1,
      method: "extension.query",
      input: { action: "agent-profile.studio-inspect", agent },
    });
    if (result.status === "error") throw new Error(result.message);
    if (result.method !== "extension.query" || result.action !== "agent-profile.studio-inspect"
      || !isAgentProfileStudioSnapshotV1(result.value)) {
      throw new Error("persistent engine returned a malformed canonical Agent Studio snapshot");
    }
    return structuredClone(result.value) as AgentProfileStudioSnapshotV1;
  }

  async commitAgentProfileStudio(mutation: AgentProfileStudioMutationV1): Promise<AgentProfileStudioSnapshotV1> {
    const result = await this.client.invoke(`agent-profile-studio:${this.operationId()}`, {
      schemaVersion: 1,
      method: "extension.invoke",
      input: { action: "agent-profile.studio-commit", mutation },
    });
    if (result.status === "error") throw new Error(result.message);
    if (result.method !== "extension.invoke" || result.action !== "agent-profile.studio-commit"
      || !isAgentProfileStudioSnapshotV1(result.value)) {
      throw new Error("persistent engine returned a malformed canonical Agent Studio commit result");
    }
    this.refreshConfig();
    return structuredClone(result.value) as AgentProfileStudioSnapshotV1;
  }

  async commitAgentProfileStudioLifecycle(mutation: AgentProfileStudioLifecycleMutationV1): Promise<AgentProfileStudioLifecycleResultV1> {
    const result = await this.client.invoke(`agent-profile-studio-lifecycle:${this.operationId()}`, {
      schemaVersion: 1,
      method: "extension.invoke",
      input: { action: "agent-profile.studio-lifecycle", mutation },
    });
    if (result.status === "error") throw new Error(result.message);
    if (result.method !== "extension.invoke" || result.action !== "agent-profile.studio-lifecycle") {
      throw new Error("persistent engine returned a malformed canonical Agent Studio lifecycle result");
    }
    const parsed = agentProfileStudioLifecycleResultSchemaV1.safeParse(result.value);
    if (!parsed.success) throw new Error("persistent engine returned a malformed canonical Agent Studio lifecycle result");
    this.refreshConfig();
    return structuredClone(parsed.data);
  }

  async exportAgentProfileStudioBundle(agent: string, expectedRevision: string): Promise<AgentProfileStudioBundleExportResultV1> {
    const result = await this.client.query({ schemaVersion: 1, method: "extension.query", input: { action: "agent-profile.studio-bundle-export", agent, expectedRevision } });
    if (result.status === "error") throw new Error(result.message);
    if (result.method !== "extension.query" || result.action !== "agent-profile.studio-bundle-export") throw new Error("persistent engine returned a mismatched profile bundle export");
    return agentProfileStudioBundleExportResultSchemaV1.parse(result.value);
  }

  async cloneAgentProfileStudioBundle(agent: string, expectedRevision: string, destinationAgentName: string): Promise<AgentProfileStudioBundleCreatedResultV1> {
    return this.invokeProfileBundle({ action: "agent-profile.studio-bundle-clone", agent, expectedRevision, destinationAgentName });
  }

  async importAgentProfileStudioBundle(destinationAgentName: string, bytes: Buffer): Promise<AgentProfileStudioBundleCreatedResultV1> {
    const staged = this.client.stagePayload(bytes);
    try { return await this.invokeProfileBundle({ action: "agent-profile.studio-bundle-import", destinationAgentName, payload: staged.ref }); }
    finally { staged.discard(); }
  }

  private async invokeProfileBundle(input: Extract<ExtensionCommandV1, { action: "agent-profile.studio-bundle-clone" | "agent-profile.studio-bundle-import" }>): Promise<AgentProfileStudioBundleCreatedResultV1> {
    const result = await this.client.invoke(`agent-profile-studio-bundle:${input.action}:${this.operationId()}`, { schemaVersion: 1, method: "extension.invoke", input });
    if (result.status === "error") throw new Error(result.message);
    if (result.method !== "extension.invoke" || result.action !== input.action) throw new Error("persistent engine returned a mismatched profile bundle result");
    const parsed = agentProfileStudioBundleCreatedResultSchemaV1.safeParse(result.value);
    if (!parsed.success) throw new Error("persistent engine returned a malformed profile bundle result");
    this.refreshConfig();
    return parsed.data;
  }

  createSoulProfile(agent: string): Promise<SoulProfileMutationTargetResult> {
    return this.invokeSoulProfile({ action: "soul.profile.create", agent });
  }

  importSoulProfileBytes(agent: string, bytes: Buffer): Promise<SoulProfileMutationTargetResult> {
    return this.invokeSoulPayload(bytes, (payload) => ({ action: "soul.profile.import", agent, payload }));
  }

  replaceSoulProfileBytes(agent: string, bytes: Buffer, expectedDigest: string): Promise<SoulProfileMutationTargetResult> {
    return this.invokeSoulPayload(bytes, (payload) => ({
      action: "soul.profile.replace",
      agent,
      payload,
      expectedDigest,
    }));
  }

  adoptSoulProfile(agent: string, expectedDigest: string): Promise<SoulProfileMutationTargetResult> {
    return this.invokeSoulProfile({ action: "soul.profile.adopt", agent, expectedDigest });
  }

  enableSoulProfile(agent: string): Promise<SoulProfileMutationTargetResult> {
    return this.invokeSoulProfile({ action: "soul.profile.enable", agent });
  }

  disableSoulProfile(agent: string): Promise<SoulProfileMutationTargetResult> {
    return this.invokeSoulProfile({ action: "soul.profile.disable", agent });
  }

  deleteSoulProfile(agent: string): Promise<SoulProfileMutationTargetResult> {
    return this.invokeSoulProfile({ action: "soul.profile.delete", agent });
  }

  async refreshSoulProfile(agent: string) {
    const result = await this.client.query({
      schemaVersion: 1,
      method: "extension.query",
      input: { action: "soul.profile.status", agent },
    });
    if (result.status === "error") throw new Error(result.message);
    if (result.method !== "extension.query" || result.action !== "soul.profile.status") {
      throw new Error("persistent engine returned a mismatched Soul profile query result");
    }
    return decodeSoulProfileOutcome(result.value, agent).status;
  }

  async canonicalSoulPathForOpen(agent: string): Promise<string> {
    const status = await this.refreshSoulProfile(agent);
    if (!status.resolvable) throw new SoulError("soul/missing", `No canonical SOUL.md exists for '${agent}'`);
    const candidate = path.resolve(this.workspaceRoot, status.relativePath);
    const relative = path.relative(this.workspaceRoot, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new SoulError("soul/outside-workspace", "Canonical SOUL.md escaped the workspace");
    }
    return candidate;
  }

  async readAgentEvolutionOverview(agent: string): Promise<EvolutionStudioOverview> {
    const result = await this.client.query({
      schemaVersion: 1,
      method: "extension.query",
      input: { action: "evolution.overview", agent },
    });
    if (result.status === "error") throw new Error(result.message);
    if (result.method !== "extension.query" || result.action !== "evolution.overview") {
      throw new Error("persistent engine returned a mismatched Agent Evolution overview result");
    }
    return decodeEvolutionOverview(result.value, agent);
  }

  async readAgentEvolutionCandidate(agent: string, candidateId: string): Promise<EvolutionStudioCandidateDetail> {
    const result = await this.client.query({
      schemaVersion: 1,
      method: "extension.query",
      input: { action: "evolution.candidate", agent, candidateId },
    });
    if (result.status === "error") throw new Error(result.message);
    if (result.method !== "extension.query" || result.action !== "evolution.candidate") {
      throw new Error("persistent engine returned a mismatched Agent Evolution candidate result");
    }
    return decodeEvolutionCandidateDetail(result.value, agent);
  }

  approveAgentEvolutionCandidate(
    agent: string,
    candidateId: string,
    input: { expectedActiveVersion: number; expectedTargetDigest?: string },
  ): Promise<{ candidateId: string; activeVersion: number }> {
    return this.resolveEvolutionCandidate("evolution.approve", agent, candidateId, input);
  }

  rejectAgentEvolutionCandidate(
    agent: string,
    candidateId: string,
    input: { expectedActiveVersion: number; expectedTargetDigest?: string },
  ): Promise<{ candidateId: string; activeVersion: number }> {
    return this.resolveEvolutionCandidate("evolution.reject", agent, candidateId, input);
  }

  private async resolveEvolutionCandidate(
    action: "evolution.approve" | "evolution.reject",
    agent: string,
    candidateId: string,
    input: { expectedActiveVersion: number; expectedTargetDigest?: string },
  ): Promise<{ candidateId: string; activeVersion: number }> {
    const result = await this.client.invoke(`agent-evolution:${this.operationId()}`, {
      schemaVersion: 1,
      method: "extension.invoke",
      input: {
        action,
        agent,
        candidateId,
        expectedActiveVersion: input.expectedActiveVersion,
        ...(input.expectedTargetDigest !== undefined ? { expectedTargetDigest: input.expectedTargetDigest } : {}),
      },
    });
    if (result.status === "error") throw new Error(result.message);
    if (result.method !== "extension.invoke" || result.action !== action) {
      throw new Error("persistent engine returned a mismatched Agent Evolution action result");
    }
    return decodeEvolutionActionResult(result.value, candidateId);
  }

  private async invokeSoulProfile(command: SoulProfileCommand): Promise<SoulProfileMutationTargetResult> {
    const result = await this.client.invoke(`soul-profile:${this.operationId()}`, {
      schemaVersion: 1,
      method: "extension.invoke",
      input: command,
    });
    if (result.status === "error") throw new Error(result.message);
    if (result.method !== "extension.invoke" || result.action !== command.action) {
      throw new Error("persistent engine returned a mismatched Soul profile command result");
    }
    const decoded = decodeSoulProfileOutcome(result.value, command.agent);
    this.refreshConfig();
    return decoded;
  }

  private async invokeSoulPayload(
    bytes: Buffer,
    command: (payload: ReturnType<WorkspaceClient["stagePayload"]>["ref"]) => SoulProfileCommand,
  ): Promise<SoulProfileMutationTargetResult> {
    const staged = this.client.stagePayload(bytes);
    try {
      return await this.invokeSoulProfile(command(staged.ref));
    } finally {
      staged.discard();
    }
  }

  private refreshConfig(): TachyonConfig | undefined {
    const read = this.readCurrentConfig(this.workspaceRoot);
    if (read.status === "valid") this.lastGoodConfig = read.config;
    else if (read.status === "missing") this.lastGoodConfig = undefined;
    return this.lastGoodConfig;
  }
}

function decodeSoulProfileOutcome(value: JsonValue, expectedAgent: string): SoulProfileMutationTargetResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("persistent engine returned an invalid Soul profile result");
  }
  if (value.outcome === "error") {
    if (Object.keys(value).length !== 2 || !isSoulErrorCode(value.code)) {
      throw new Error("persistent engine returned an invalid Soul profile error");
    }
    throw new SoulError(value.code, `Soul profile operation failed for '${expectedAgent}'`);
  }
  const keys = Object.keys(value);
  if (value.outcome !== "ok"
    || !keys.every((key) => key === "outcome" || key === "status" || key === "selfSelected")
    || keys.length < 2 || keys.length > 3
    || !isSoulProfileStatusMessage(value.status)
    || value.status.agent !== expectedAgent
    || (value.selfSelected !== undefined && typeof value.selfSelected !== "boolean")) {
    throw new Error("persistent engine returned an invalid Soul profile success result");
  }
  return {
    status: projectSoulProfileStatus(value.status),
    ...(value.selfSelected !== undefined ? { selfSelected: value.selfSelected } : {}),
  };
}

function decodeEvolutionOverview(value: JsonValue, expectedAgent: string): EvolutionStudioOverview {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !("summary" in value) || !("candidates" in value)
    || !validateAgentStudioHostDomainMessage({ type: "evolutionSummary", studioProtocolVersion: 1, summary: value.summary })
    || !validateAgentStudioHostDomainMessage({ type: "evolutionCandidates", studioProtocolVersion: 1, agent: expectedAgent, candidates: value.candidates })
    || typeof value.summary !== "object" || value.summary === null || Array.isArray(value.summary)
    || value.summary.agent !== expectedAgent) {
    throw new Error("persistent engine returned an invalid Agent Evolution overview");
  }
  return value as unknown as EvolutionStudioOverview;
}

function decodeEvolutionCandidateDetail(value: JsonValue, expectedAgent: string): EvolutionStudioCandidateDetail {
  if (!validateAgentStudioHostDomainMessage({
    type: "evolutionCandidateDetail",
    studioProtocolVersion: 1,
    agent: expectedAgent,
    detail: value,
  })) {
    throw new Error("persistent engine returned an invalid Agent Evolution candidate detail");
  }
  return value as unknown as EvolutionStudioCandidateDetail;
}

function decodeEvolutionActionResult(
  value: JsonValue,
  expectedCandidateId: string,
): { candidateId: string; activeVersion: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("persistent engine returned an invalid Agent Evolution action result");
  }
  if (value.outcome === "error") {
    if (Object.keys(value).length !== 2 || typeof value.code !== "string" || !/^evolution\/[a-z0-9-]+$/.test(value.code)) {
      throw new Error("persistent engine returned an invalid Agent Evolution action error");
    }
    throw new EvolutionStoreError(value.code as EvolutionStoreErrorCode, "Agent Evolution action failed");
  }
  if (value.outcome !== "ok"
    || Object.keys(value).some((key) => key !== "outcome" && key !== "candidateId" && key !== "activeVersion")
    || value.candidateId !== expectedCandidateId
    || !Number.isSafeInteger(value.activeVersion) || (value.activeVersion as number) < 0) {
    throw new Error("persistent engine returned an invalid Agent Evolution action result");
  }
  return { candidateId: value.candidateId, activeVersion: value.activeVersion as number };
}

function readWorkspaceConfig(workspaceRoot: string): WorkspaceConfigReadResult {
  for (const fileName of CONFIG_FILENAMES) {
    const file = path.join(workspaceRoot, fileName);
    if (!fs.existsSync(file)) continue;
    const yamlText = fs.readFileSync(file, "utf8");
    const loaded = parseProfileAwareConfigSyntax(yamlText);
    if (!loaded.config) return { status: "invalid" };
    const pointers = scanAgentProfilePointers(yamlText);
    if (pointers.errors.length > 0) return { status: "invalid" };
    for (const name of pointers.pointers.keys()) {
      // A profile pointer is an Agent-arm marker; a terminal entry can never carry one.
      const def = asAgent(loaded.config.agents[name]);
      if (def) def.profilePointer = true;
    }
    return { status: "valid", config: loaded.config };
  }
  return { status: "missing" };
}
