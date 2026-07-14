import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CONFIG_FILENAMES,
  inferKind,
  loadConfigFile,
  type TachyonConfig,
} from "../config/loadConfig.js";
import { collectVerifyCandidates } from "../config/verifyCandidates.js";
import { detectInstalledClis } from "../webview/cliDetect.js";
import type { StudioDeps, StudioSubmit } from "../webview/studioSubmit.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import type { WorkspaceStudioTarget } from "./WorkspacePresentation.js";

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
export class ClientWorkspaceStudioTarget implements WorkspaceStudioTarget {
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
    const loaded = loadConfigFile(file);
    return loaded.config ? { status: "valid", config: loaded.config } : { status: "invalid" };
  }
  return { status: "missing" };
}
