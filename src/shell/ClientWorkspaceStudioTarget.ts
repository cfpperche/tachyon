import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SoulError, isSoulErrorCode } from "../agents/soul.js";
import {
  CONFIG_FILENAMES,
  inferKind,
  loadConfigFile,
  type TachyonConfig,
} from "../config/loadConfig.js";
import { collectVerifyCandidates } from "../config/verifyCandidates.js";
import { detectInstalledClis } from "../webview/cliDetect.js";
import type { StudioDeps, StudioSubmit } from "../webview/studioSubmit.js";
import {
  isSoulProfileStatusMessage,
  projectSoulProfileStatus,
} from "../webview/agent-studio-shell/domain.js";
import type { ExtensionCommandV1, JsonValue } from "../runtime-api/extensionOperations.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import type {
  SoulProfileMutationTargetResult,
  WorkspaceAgentStudioTarget,
} from "./WorkspacePresentation.js";

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
      inferKind,
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

function readWorkspaceConfig(workspaceRoot: string): WorkspaceConfigReadResult {
  for (const fileName of CONFIG_FILENAMES) {
    const file = path.join(workspaceRoot, fileName);
    if (!fs.existsSync(file)) continue;
    const loaded = loadConfigFile(file);
    return loaded.config ? { status: "valid", config: loaded.config } : { status: "invalid" };
  }
  return { status: "missing" };
}
