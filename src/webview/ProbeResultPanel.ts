import * as vscode from "vscode";
import type { WorkspaceProbePresentationTarget } from "../shell/WorkspacePresentation.js";
import {
  SectionPanelManager,
  type SectionAppConfig,
  type SectionPanelSession,
  type SectionPanelState,
  type SectionPanelTarget,
} from "./shared/SectionPanelManager.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import { probesMessage, PROBES } from "./probes/messages.js";

export const PROBES_VIEW_TYPE = "tachyonProbes";

/** The pre-410 persisted shape; caller-less means the workspace-wide probe document. */
export interface ProbesPanelState {
  schemaVersion: 1;
  view: typeof PROBES_VIEW_TYPE;
  wsHash: string;
  caller?: string;
}

type ProbesRefreshKind = "probes";

const WORKSPACE_IDENTITY = "workspace";
const agentIdentity = (caller: string): string => `agent:${caller}`;
const callerFrom = (target: SectionPanelTarget): string | undefined =>
  target.identity === WORKSPACE_IDENTITY ? undefined : target.identity?.startsWith("agent:") ? target.identity.slice(6) : undefined;

/** SDD 485 D18 — one Probes document per immutable workspace-wide or (workspace, caller) identity. */
export class ProbeResultPanelManager {
  private readonly manager: SectionPanelManager<ProbesRefreshKind>;

  constructor(
    extensionUri: vscode.Uri,
    private readonly getWorkspaces: () => WorkspaceProbePresentationTarget[],
    app: WebviewAppEntry = webviewApp("probes"),
  ) {
    this.manager = new SectionPanelManager(extensionUri, this.configFor(app));
  }

  open(project: string, caller?: string): void {
    this.manager.open({ project, identity: caller ? agentIdentity(caller) : WORKSPACE_IDENTITY });
  }

  refresh(): number { return this.manager.refresh("probes"); }

  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState | ProbesPanelState): void {
    this.manager.deserialize(panel, migrateLegacy(state));
  }

  get openKeys(): string[] { return this.manager.openKeys; }

  dispose(): void { this.manager.dispose(); }

  private configFor(app: WebviewAppEntry): SectionAppConfig<ProbesRefreshKind> {
    return {
      app,
      // Measured before cutover: cockpit.css has zero .probes-root consumers; probes.css owns them all.
      styleFiles: ["codicon.css", "design-system.css", "probes.css"],
      title: (target) => {
        const caller = callerFrom(target);
        return caller ? vscode.l10n.t("Probes — {0}", caller) : vscode.l10n.t("Captured Probes");
      },
      refreshKindFor: (message) => isReady(message) ? "probes" : undefined,
      bind: (session) => this.bind(session),
    };
  }

  private bind(session: SectionPanelSession<ProbesRefreshKind>) {
    let requestToken = 0;
    let alive = true;
    const send = async (): Promise<void> => {
      const token = ++requestToken;
      const ws = this.getWorkspaces().find((workspace) => workspace.wsHash === session.target.project);
      if (!ws) {
        if (alive && token === requestToken) session.post(probesMessage({ folder: "", error: "No Tachyon workspace for Probes." }));
        return;
      }
      try {
        const view = await ws.probeView(callerFrom(session.target));
        if (alive && token === requestToken) session.post(probesMessage({ folder: ws.folderName, view }));
      } catch (error) {
        if (alive && token === requestToken) session.post(probesMessage({
          folder: ws.folderName,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    };
    return {
      replay: () => { void send(); },
      resync: () => { void send(); },
      onReveal: () => { void send(); },
      dispose: () => { alive = false; requestToken++; },
    };
  }
}

function migrateLegacy(state: SectionPanelState | ProbesPanelState): SectionPanelState {
  if (!("wsHash" in state)) return state;
  return {
    schemaVersion: 1,
    view: PROBES_VIEW_TYPE,
    project: state.wsHash,
    identity: state.caller ? agentIdentity(state.caller) : WORKSPACE_IDENTITY,
  };
}

function isReady(message: unknown): boolean {
  return !!message && typeof message === "object" && (message as { type?: unknown }).type === "ready";
}

export { PROBES };
