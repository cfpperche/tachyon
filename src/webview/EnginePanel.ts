import * as vscode from "vscode";
import { buildCockpitModel, collectNeedsFor, type CockpitWorkspaceBundle } from "../cockpit/model.js";
import {
  SectionPanelManager,
  type SectionAppConfig,
  type SectionPanelSession,
  type SectionPanelState,
} from "./shared/SectionPanelManager.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import { POLL, READY, engineErrorMessage, engineModelMessage } from "./engine/messages.js";

/**
 * SDD 485 D5 gives Engine a NEW viewType rather than reusing `tachyonControlInspector`. The legacy id
 * names a retired, dispose-only inspector — a different surface. Reusing it would repeat C5's mistake
 * of making one viewType mean two incompatible surfaces.
 */
export const ENGINE_VIEW_TYPE = "tachyonEngine";

type EngineRefreshKind = "engine";

export interface EngineDeps {
  collect: (needs?: ReturnType<typeof collectNeedsFor>) => Promise<CockpitWorkspaceBundle[]>;
  openDoctor(): void;
  clearEngineLog(wsHash: string): Promise<void>;
  openEngineJournal(wsHash: string): void;
}

/**
 * Engine is a `dashboard`, one panel per project. `buildCockpitModel(bundles, { wsHash })` validates
 * and filters the bundles before producing `m.control.workspaces`; that plural is the old aggregate
 * model's shape, not a cross-project data source.
 */
export class EnginePanelManager {
  private readonly manager: SectionPanelManager<EngineRefreshKind>;

  constructor(
    extensionUri: vscode.Uri,
    private readonly deps: EngineDeps,
    app: WebviewAppEntry = webviewApp("engine"),
    scope?: ControlWorkspaceScope,
  ) {
    this.manager = new SectionPanelManager(extensionUri, this.configFor(app), scope);
  }

  open(project: string) {
    this.manager.open({ project });
  }

  openInCurrentScope() {
    return this.manager.openInCurrentScope();
  }

  refresh() {
    return this.manager.refresh("engine");
  }

  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState) {
    this.manager.deserialize(panel, state);
  }

  dispose() {
    this.manager.dispose();
  }

  private configFor(app: WebviewAppEntry): SectionAppConfig<EngineRefreshKind> {
    return {
      app,
      // Shared by this app and Control (`Cockpit.ts` links it too): one definition for the Engine
      // workspace/log contract, not two copies. Worktrees' 21 `ck-wt-*` uses remain with Control.
      styleFiles: ["codicon.css", "design-system.css", "engine-workspace.css"],
      title: () => vscode.l10n.t("Engine"),
      bootstrapGlobals: () => ({
        __TACHYON_STRINGS__: {
          engineTitle: vscode.l10n.t("Engine / Bridge"),
          openDoctor: vscode.l10n.t("Run Doctor"),
          empty: vscode.l10n.t("Nothing to show."),
          attached: vscode.l10n.t("Attached"),
          error: vscode.l10n.t("Error"),
          none: vscode.l10n.t("None"),
          state: vscode.l10n.t("State"),
          pid: "PID",
          version: vscode.l10n.t("Version"),
          instance: vscode.l10n.t("Instance"),
          started: vscode.l10n.t("Started"),
          bundle: vscode.l10n.t("Bundle"),
          protocol: vscode.l10n.t("Protocol"),
          url: "URL",
          port: vscode.l10n.t("Port"),
          auth: vscode.l10n.t("Auth"),
          root: vscode.l10n.t("Root"),
          hash: vscode.l10n.t("Hash"),
          agents: vscode.l10n.t("Agents"),
          running: vscode.l10n.t("running"),
        },
      }),
      refreshKindFor: engineRefreshKind,
      bind: (session) => {
        const send = () => void this.send(session);
        return {
          replay: send,
          resync: send,
          onMessage: (raw) => void this.action(session, raw),
        };
      },
    };
  }

  private async send(session: SectionPanelSession<EngineRefreshKind>) {
    try {
      const bundles = await this.deps.collect(collectNeedsFor("engine"));
      session.post(
        engineModelMessage(
          buildCockpitModel(bundles, {
            section: "engine",
            wsHash: session.target.project,
          }),
        ),
      );
    } catch (e) {
      session.post(engineErrorMessage(e instanceof Error ? e.message : String(e)));
    }
  }

  private async action(session: SectionPanelSession<EngineRefreshKind>, raw: unknown) {
    const m = raw as Record<string, unknown>;
    if (m.type === "openDoctor") this.deps.openDoctor();
    else if (m.type === "copyText" && typeof m.text === "string") await vscode.env.clipboard.writeText(m.text);
    else if (m.type === "engineLogJournal" && typeof m.wsHash === "string") this.deps.openEngineJournal(m.wsHash);
    else if (m.type === "engineLogClear" && typeof m.wsHash === "string") {
      await this.deps.clearEngineLog(m.wsHash);
      await this.send(session);
    }
  }
}

export function engineRefreshKind(message: unknown): EngineRefreshKind | undefined {
  if (!message || typeof message !== "object") return;
  const type = (message as { type?: unknown }).type;
  return type === READY || type === POLL ? "engine" : undefined;
}
