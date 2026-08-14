import * as vscode from "vscode";
import type {
  RuntimeConfigChange,
  RuntimeConfigControlSnapshot,
  RuntimeConfigRuntime,
} from "@tachyon/webview-ui/runtimeConfig/types";
import type { RuntimeConfigStrings } from "@tachyon/webview-ui/webview/runtime-config/messages";
import {
  POLL,
  READY,
  runtimeConfigSnapshotMessage,
  runtimeConfigSnapshotUnavailableMessage,
} from "@tachyon/webview-ui/webview/runtime-config/messages";
import {
  SectionPanelManager,
  type SectionAppConfig,
  type SectionPanelSession,
  type SectionPanelState,
} from "./shared/SectionPanelManager.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";

export const RUNTIME_CONFIG_VIEW_TYPE = "tachyonRuntimeConfig";
type RuntimeConfigRefreshKind = "runtime-config";

export interface RuntimeConfigDeps {
  buildSnapshot: (wsHash: string) => RuntimeConfigControlSnapshot | undefined;
  openSource: (sourcePath: string) => Promise<void>;
  saveChanges: (input: {
    wsHash: string;
    runtime: RuntimeConfigRuntime;
    documentId: string;
    expectedRevision?: string;
    changes: RuntimeConfigChange[];
  }) => Promise<void>;
}

/**
 * SDD 485 D8 — Runtime Config is a dashboard because buildSnapshot(wsHash) reads one workspace root.
 * Every read and mutation uses the immutable session target; client-supplied workspace fields are ignored.
 *
 * There is no legacy standalone Runtime Config viewType to revive. The surface uses only `rcp-` rules
 * from runtime-config.css, so no shared Control class sheet is linked.
 */
export class RuntimeConfigPanelManager {
  private readonly manager: SectionPanelManager<RuntimeConfigRefreshKind>;

  constructor(
    extensionUri: vscode.Uri,
    private readonly deps: RuntimeConfigDeps,
    app: WebviewAppEntry = webviewApp("runtime-config"),
    scope?: ControlWorkspaceScope,
  ) {
    this.manager = new SectionPanelManager(extensionUri, this.configFor(app), scope);
  }

  open(project: string): void { this.manager.open({ project }); }
  get openKeys(): string[] { return this.manager.openKeys; }
  openInCurrentScope(): boolean { return this.manager.openInCurrentScope(); }
  refresh(): void { this.manager.refresh("runtime-config"); }
  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState): void { this.manager.deserialize(panel, state); }
  dispose(): void { this.manager.dispose(); }

  private configFor(app: WebviewAppEntry): SectionAppConfig<RuntimeConfigRefreshKind> {
    return {
      app,
      styleFiles: ["codicon.css", "tokens.css", "faces.css", "design-system.css", "quick-picker.css", "runtime-config.css"],
      title: () => vscode.l10n.t("Runtime Config"),
      bootstrapGlobals: () => ({ __TACHYON_STRINGS__: runtimeConfigStrings() }),
      refreshKindFor: runtimeConfigRefreshKind,
      bind: (session) => {
        const knownPaths = new Set<string>();
        const send = () => this.send(session, knownPaths);
        return { replay: () => { void send(); }, resync: () => { void send(); }, onMessage: (raw) => { void this.action(session, knownPaths, raw); } };
      },
    };
  }

  private async send(
    session: SectionPanelSession<RuntimeConfigRefreshKind>,
    knownPaths: Set<string>,
  ): Promise<void> {
    const project = this.projectOf(session);
    const snapshot = this.deps.buildSnapshot(project);
    knownPaths.clear();
    if (!snapshot) {
      session.post(runtimeConfigSnapshotUnavailableMessage());
      return;
    }
    for (const document of snapshot.runtimes.flatMap((runtime) => runtime.documents)) {
      knownPaths.add(document.path);
    }
    session.post(runtimeConfigSnapshotMessage(snapshot));
  }

  private async action(
    session: SectionPanelSession<RuntimeConfigRefreshKind>,
    knownPaths: Set<string>,
    raw: unknown,
  ): Promise<void> {
    const message = raw as Record<string, unknown>;
    if (message.type === "openRuntimeConfigSource" && typeof message.path === "string" && knownPaths.has(message.path)) {
      await this.deps.openSource(message.path);
      return;
    }
    if (
      message.type === "saveRuntimeConfigChanges"
      && (message.runtime === "codex" || message.runtime === "claude" || message.runtime === "grok")
      && typeof message.documentId === "string"
      && Array.isArray(message.changes)
    ) {
      await this.deps.saveChanges({
        wsHash: this.projectOf(session),
        runtime: message.runtime,
        documentId: message.documentId,
        expectedRevision: typeof message.expectedRevision === "string" ? message.expectedRevision : undefined,
        changes: message.changes as RuntimeConfigChange[],
      });
      await this.send(session, knownPaths);
    }
  }

  private projectOf(session: SectionPanelSession<RuntimeConfigRefreshKind>): string {
    const project = session.target.project;
    if (!project) throw new Error("Runtime Config dashboard has no project");
    return project;
  }
}

export function runtimeConfigRefreshKind(message: unknown): RuntimeConfigRefreshKind | undefined {
  if (!message || typeof message !== "object") return undefined;
  const type = (message as { type?: unknown }).type;
  return type === READY || type === POLL ? "runtime-config" : undefined;
}

function runtimeConfigStrings(): RuntimeConfigStrings {
  const t = vscode.l10n.t;
  return {
    none: t("None"),
    runtimeConfigTitle: t("Runtime Config"),
    runtimeConfigHint: t("Global runtime configuration, capabilities, and agent impact."),
    runtimeConfigEditable: t("Editable measured settings"),
    runtimeConfigGlobalWarning: t("Global changes also affect the selected runtime outside Tachyon."),
    runtimeConfigUnset: t("Not set"),
    runtimeConfigRuntime: t("Runtime"),
    runtimeConfigScope: t("Scope"),
    runtimeConfigCapabilities: t("Runtime capabilities"),
    runtimeConfigOther: t("Other settings"),
    runtimeConfigSourceFile: t("Source file"),
    runtimeConfigUsedBy: t("Used by agents"),
    runtimeConfigConfigured: t("configured"),
    runtimeConfigDetected: t("detected"),
    runtimeConfigOpenFile: t("Open file"),
    runtimeConfigSave: t("Save changes"),
    runtimeConfigViewRaw: t("View keys"),
    runtimeConfigCodex: t("OpenAI Codex"),
    runtimeConfigClaude: t("Anthropic Claude"),
    runtimeConfigGrok: t("xAI Grok"),
    runtimeConfigGlobalConfig: t("Global config"),
    runtimeConfigWorkspaceConfig: t("Workspace config"),
    runtimeConfigGlobalSettings: t("Global settings"),
    runtimeConfigWorkspaceSettings: t("Workspace settings"),
    runtimeConfigWorkspaceMcp: t("Workspace MCP"),
    runtimeConfigFolderTrust: t("Folder trust"),
    runtimeConfigTheme: t("Theme"),
    runtimeConfigReducedMotion: t("Reduced motion"),
    runtimeConfigSpinnerTips: t("Spinner tips"),
    runtimeConfigTurnDuration: t("Turn duration"),
    runtimeConfigTerminalProgress: t("Terminal progress bar"),
    runtimeConfigAlwaysThinking: t("Always thinking"),
    runtimeConfigReadOnly: t("Read only"),
    runtimeConfigReadOnlyDocument: t("This source is read-only in Control."),
    runtimeConfigHiddenRecords: t("runtime-managed records are hidden from this inventory."),
    runtimeConfigOverriddenBy: t("Overridden by"),
    runtimeConfigOpaqueSections: t("Opaque sections"),
    runtimeConfigReadError: t("Could not read this runtime configuration source"),
    runtimeConfigUnavailable: t("Runtime configuration is unavailable because this workspace configuration did not load."),
  };
}
