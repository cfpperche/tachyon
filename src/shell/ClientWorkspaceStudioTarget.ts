import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  asAgent,
  CONFIG_FILENAMES,
  suggestKindForCommand,
  type TachyonConfig,
} from "../config/loadConfig.js";
import type { AuthorizableCapabilities } from "../config/agentCapabilityCandidates.js";
import { agentForgetPlanResultSchemaV1, type AgentForgetPlanResultV1 } from "@tachyon/shared/config/agentForgetPlan.js";
import { parseProfileAwareConfigSyntax } from "../config/agentProfileConfigLoader.js";
import { scanAgentRosterDirectory } from "../config/agentRosterDirectory.js";
import { detectInstalledClis } from "../webview/cliDetect.js";
import type { StudioDeps, StudioSubmit } from "../webview/studioSubmit.js";
import { canonicalWorkspaceStudioFormV1 } from "../engine-service/protocol.js";
import type { ExtensionCommandV1 } from "../runtime-api/extensionOperations.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import type { WorkspaceAgentStudioTarget } from "./WorkspacePresentation.js";
import {
  agentOwnershipViewSchemaV1,
  isAgentProfileStudioSnapshotV1,
  agentProfileStudioLifecycleResultSchemaV1,
  agentProfileStudioBundleCreatedResultSchemaV1,
  agentProfileStudioBundleExportResultSchemaV1,
  type AgentOwnershipViewV1,
  type AgentProfileStudioBundleCreatedResultV1,
  type AgentProfileStudioBundleExportResultV1,
  type AgentProfileStudioLifecycleMutationV1,
  type AgentProfileStudioLifecycleResultV1,
  type AgentProfileStudioMutationV1,
  type AgentProfileStudioSnapshotV1,
} from "@tachyon/shared/config/agentProfileStudio.js";

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
        // t-8247ec — an untyped caller may hand this seam a partial form; canonicalize so an
        // omission reaches the domain as a validation error instead of failing in transport.
        state: canonicalWorkspaceStudioFormV1(submit.state),
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

  /**
   * t-4c113c — the editor-side config is a SYNTAX-only parse (`parseProfileAwareConfigSyntax` stubs
   * every name the roster directory yields), so `agents.<n>.subagents` does not exist here and the
   * roster cannot be derived locally. The engine, which projects the canonical profiles, is the only
   * place that knows.
   */
  async agentOwnershipView(agent: string): Promise<AgentOwnershipViewV1> {
    const result = await this.client.query({
      schemaVersion: 1,
      method: "extension.query",
      input: { action: "agent-profile.studio-ownership", agent },
    });
    if (result.status === "error") throw new Error(result.message);
    if (result.method !== "extension.query" || result.action !== "agent-profile.studio-ownership") {
      throw new Error("persistent engine returned a mismatched declared-ownership result");
    }
    const parsed = agentOwnershipViewSchemaV1.safeParse(result.value);
    if (!parsed.success) throw new Error("persistent engine returned a malformed declared-ownership result");
    return parsed.data;
  }

  /**
   * SDD 482 phase 4 — create a Saved Agent and record its owner in ONE canonical transaction.
   *
   * A distinct action rather than a flag on `studio-commit`: that payload is `.strict()`, so widening
   * it would make a newer engine undecodable to an older shell. A new action is refused by name on an
   * older engine and never sent by an older client, which is skew-safe in both directions.
   */
  async createSavedAgentWithOwner(
    mutation: AgentProfileStudioMutationV1,
    owner: string,
  ): Promise<{ revision: string; txid: string }> {
    const result = await this.client.invoke(`saved-agent-create:${this.operationId()}`, {
      schemaVersion: 1,
      method: "extension.invoke",
      input: { action: "agent-profile.saved-agent-create", mutation, owner },
    });
    if (result.status === "error") throw new Error(result.message);
    if (result.method !== "extension.invoke" || result.action !== "agent-profile.saved-agent-create") {
      throw new Error("persistent engine returned a malformed Saved Agent creation result");
    }
    const value = result.value as { revision?: unknown; txid?: unknown };
    if (typeof value?.revision !== "string" || typeof value?.txid !== "string") {
      throw new Error("persistent engine returned a malformed Saved Agent creation result");
    }
    this.refreshConfig();
    return { revision: value.revision, txid: value.txid };
  }

  /** SDD 483 — governed create with optional durable owner and human-approved narrow grants. */
  async createSavedAgent(
    mutation: AgentProfileStudioMutationV1,
    options: { owner?: string; grants?: { proposeSavedAgent?: true } },
  ): Promise<{ revision: string; txid: string }> {
    const result = await this.client.invoke(`saved-agent-create-v2:${this.operationId()}`, {
      schemaVersion: 1,
      method: "extension.invoke",
      input: { action: "agent-profile.saved-agent-create-v2", mutation, ...options },
    });
    if (result.status === "error") throw new Error(result.message);
    if (result.method !== "extension.invoke" || result.action !== "agent-profile.saved-agent-create-v2") {
      throw new Error("persistent engine returned a malformed Saved Agent creation result");
    }
    const value = result.value as { revision?: unknown; txid?: unknown };
    if (typeof value?.revision !== "string" || typeof value?.txid !== "string") {
      throw new Error("persistent engine returned a malformed Saved Agent creation result");
    }
    this.refreshConfig();
    return { revision: value.revision, txid: value.txid };
  }

  /**
   * t-5498a6 — authorize a workspace skill for an agent that already exists.
   *
   * The engine answers refusals as VALUES (`{ ok: false, error }`), so a "this plugin does not
   * install for codex" reaches the human as itself instead of as a transport error. Only a genuine
   * engine failure throws.
   */
  async authorizeAgentSkill(
    agentName: string,
    skillName: string,
    options: { reauthorize?: boolean } = {},
  ): Promise<
    | { ok: true; outcome: string; referenceId: string; reachesAgentAtNextLaunch?: boolean }
    | { ok: false; error: string }
  > {
    const result = await this.client.invoke(`authorize-skill:${this.operationId()}`, {
      schemaVersion: 1,
      method: "extension.invoke",
      input: { action: "agent-profile.authorize-skill", agentName, skillName, ...options },
    });
    if (result.status === "error") throw new Error(result.message);
    if (result.method !== "extension.invoke" || result.action !== "agent-profile.authorize-skill") {
      throw new Error("persistent engine returned a malformed skill authorization result");
    }
    const value = result.value as {
      ok?: unknown; error?: unknown; outcome?: unknown; referenceId?: unknown; reachesAgentAtNextLaunch?: unknown;
    };
    if (value?.ok === false && typeof value.error === "string") return { ok: false, error: value.error };
    if (value?.ok !== true || typeof value.outcome !== "string" || typeof value.referenceId !== "string") {
      throw new Error("persistent engine returned a malformed skill authorization result");
    }
    this.refreshConfig();
    // t-746f0f — absent means "the engine did not say", which is the same answer an older engine
    // gives. Decoded permissively for that reason: the flag adds a sentence, and a shell that never
    // hears it falls back to today's silent success rather than rejecting the whole result.
    return {
      ok: true,
      outcome: value.outcome,
      referenceId: value.referenceId,
      ...(value.reachesAgentAtNextLaunch === true ? { reachesAgentAtNextLaunch: true } : {}),
    };
  }

  /** t-5498a6 — the two candidate lists, queried fresh rather than read off the revisioned snapshot. */
  async authorizableCapabilitiesFor(agent: string): Promise<AuthorizableCapabilities> {
    const result = await this.client.query({
      schemaVersion: 1,
      method: "extension.query",
      input: { action: "agent-profile.authorizable-capabilities", agent },
    });
    if (result.status === "error") throw new Error(result.message);
    if (result.method !== "extension.query" || result.action !== "agent-profile.authorizable-capabilities") {
      throw new Error("persistent engine returned a malformed capability candidate result");
    }
    const value = result.value as Partial<AuthorizableCapabilities>;
    if (!Array.isArray(value?.workspaceSkills) || !Array.isArray(value?.plugins)) {
      throw new Error("persistent engine returned a malformed capability candidate result");
    }
    return {
      workspaceSkills: value.workspaceSkills,
      plugins: value.plugins,
      checkoutOnlyPlugins: Array.isArray(value.checkoutOnlyPlugins) ? value.checkoutOnlyPlugins : [],
    };
  }

  /** t-5498a6 — authorize a whole plugin; a refusal arrives as a value, never as a transport error. */
  async authorizeAgentPlugin(
    agentName: string,
    pluginName: string,
    options: { reauthorize?: boolean } = {},
  ): Promise<
    | { ok: true; authorized: string[]; outcomes: string[]; reachesAgentAtNextLaunch?: boolean }
    | { ok: false; error: string }
  > {
    const result = await this.client.invoke(`authorize-plugin:${this.operationId()}`, {
      schemaVersion: 1,
      method: "extension.invoke",
      input: { action: "agent-profile.authorize-plugin", agentName, pluginName, ...options },
    });
    if (result.status === "error") throw new Error(result.message);
    if (result.method !== "extension.invoke" || result.action !== "agent-profile.authorize-plugin") {
      throw new Error("persistent engine returned a malformed plugin authorization result");
    }
    const value = result.value as {
      ok?: unknown; error?: unknown; authorized?: unknown; outcomes?: unknown; reachesAgentAtNextLaunch?: unknown;
    };
    if (value?.ok === false && typeof value.error === "string") return { ok: false, error: value.error };
    // t-4a2a6f — `outcomes` must be present AND aligned with `authorized`. The caller reads them by
    // index to say which skills were written and which were held back, so a short or missing array
    // would silently reclassify a refused skill as an authorized one.
    if (value?.ok !== true || !Array.isArray(value.authorized) || !Array.isArray(value.outcomes)
      || value.outcomes.length !== value.authorized.length) {
      throw new Error("persistent engine returned a malformed plugin authorization result");
    }
    this.refreshConfig();
    return {
      ok: true,
      authorized: value.authorized as string[],
      outcomes: value.outcomes as string[],
      // t-746f0f — same permissive decode as the skill door.
      ...(value.reachesAgentAtNextLaunch === true ? { reachesAgentAtNextLaunch: true } : {}),
    };
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

  async planAgentProfileForget(agent: string, expectedRevision: string): Promise<AgentForgetPlanResultV1> {
    const result = await this.client.query({
      schemaVersion: 1,
      method: "extension.query",
      input: { action: "agent-profile.forget-plan", agent, expectedRevision },
    });
    if (result.status === "error") throw new Error(result.message);
    if (result.method !== "extension.query" || result.action !== "agent-profile.forget-plan") {
      throw new Error("persistent engine returned a mismatched agent forget plan");
    }
    const parsed = agentForgetPlanResultSchemaV1.safeParse(result.value);
    if (!parsed.success) throw new Error("persistent engine returned a malformed agent forget plan");
    return parsed.data;
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

  private refreshConfig(): TachyonConfig | undefined {
    const read = this.readCurrentConfig(this.workspaceRoot);
    if (read.status === "valid") this.lastGoodConfig = read.config;
    else if (read.status === "missing") this.lastGoodConfig = undefined;
    return this.lastGoodConfig;
  }
}

function readWorkspaceConfig(workspaceRoot: string): WorkspaceConfigReadResult {
  for (const fileName of CONFIG_FILENAMES) {
    const file = path.join(workspaceRoot, fileName);
    if (!fs.existsSync(file)) continue;
    const yamlText = fs.readFileSync(file, "utf8");
    // t-ae221c — the roster is measured off `.tachyon/agents/`, not read out of the file. The syntax
    // pass takes no filesystem reads of its own on purpose, so the names are measured here and
    // passed in; the retired `agents:` block, if the human still has one, is ignored with a warning.
    const roster = scanAgentRosterDirectory(workspaceRoot).members;
    const loaded = parseProfileAwareConfigSyntax(yamlText, roster);
    if (!loaded.config) return { status: "invalid" };
    for (const name of roster) {
      // A canonical profile is an Agent-arm marker; a terminal entry can never carry one.
      const def = asAgent(loaded.config.agents[name]);
      if (def) def.profilePointer = true;
    }
    return { status: "valid", config: loaded.config };
  }
  return { status: "missing" };
}
