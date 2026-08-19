import * as vscode from "vscode";
import { redactSecrets } from "@tachyon/engine/utils/redactSecrets.js";
import type { WorkspaceAgentStudioTarget } from "../shell/WorkspacePresentation.js";
import { SectionPanelManager, type SectionAppConfig, type SectionPanelSession, type SectionPanelState } from "./shared/SectionPanelManager.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import { errorMessage, isKeysModel, modelMessage, READY, type KeysAction, type KeysModel } from "@tachyon/webview-ui/webview/keys/messages";

export const KEYS_VIEW_TYPE = "tachyonKeys";
type RefreshKind = "keys";
export interface KeysDeps { byHash(hash: string): WorkspaceAgentStudioTarget | undefined }

export class KeysPanelManager {
  private readonly manager: SectionPanelManager<RefreshKind>;
  constructor(extensionUri: vscode.Uri, private readonly deps: KeysDeps, app: WebviewAppEntry = webviewApp("keys"), scope?: ControlWorkspaceScope) {
    this.manager = new SectionPanelManager(extensionUri, this.configFor(app), scope);
  }
  open(project: string): void { this.manager.open({ project }); }
  refresh(): void { this.manager.refresh("keys"); }
  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState): void { this.manager.deserialize(panel, state); }
  dispose(): void { this.manager.dispose(); }
  private configFor(app: WebviewAppEntry): SectionAppConfig<RefreshKind> {
    return {
      app,
      styleFiles: ["codicon.css", "tokens.css", "faces.css", "design-system.css", "quick-picker.css", "keys.css"],
      title: () => "Keys",
      refreshKindFor: (message) => message && typeof message === "object" && (message as { type?: unknown }).type === READY ? "keys" : undefined,
      bind: (session) => ({ replay: () => void this.send(session), resync: () => void this.send(session), onMessage: (raw) => void this.action(session, raw) }),
    };
  }
  private async send(session: SectionPanelSession<RefreshKind>): Promise<void> {
    const project = session.target.project; const ws = project ? this.deps.byHash(project) : undefined;
    if (!ws) { session.post(errorMessage("No Tachyon workspace is attached.")); return; }
    try {
      const model = toModel(await ws.secretInventory());
      if (!isKeysModel(model)) {
        session.post(errorMessage("The machine-key inventory did not match the safe projection schema."));
        return;
      }
      session.post(modelMessage(model));
    } catch (error) { session.post(errorMessage(safeError(error))); }
  }
  private async action(session: SectionPanelSession<RefreshKind>, raw: unknown): Promise<void> {
    const action = raw as Partial<KeysAction>; const ws = session.target.project ? this.deps.byHash(session.target.project) : undefined;
    if (!ws || typeof action.type !== "string") return;
    try {
      if (action.type === "storeKey" && typeof action.provider === "string"
        && typeof action.id === "string" && typeof action.value === "string") {
        await ws.setProfileSecret(action.provider, action.id, action.value);
      } else if (action.type === "replaceKey" && typeof action.provider === "string"
        && typeof action.id === "string" && typeof action.value === "string") {
        await ws.replaceProfileSecret(action.provider, action.id, action.value);
      } else if (action.type === "removeKey" && typeof action.provider === "string"
        && typeof action.id === "string") {
        await ws.removeProfileSecret(action.provider, action.id);
      }
      else return;
      await this.send(session);
    } catch (error) { session.post(errorMessage(safeError(error))); }
  }
}
export function toModel(inventory: {
  stored: Array<{ provider: string; id: string; [key: string]: unknown }>;
  required: Array<{ agent: string; name: string; provider: string; id: string; purpose: string; [key: string]: unknown }>;
}): KeysModel {
  const required = inventory.required.map(({ agent, name, provider, id, purpose }) => ({ agent, name, provider, id, purpose }));
  const stored = inventory.stored.map(key => ({
    provider: key.provider,
    id: key.id,
    usedBy: required.filter(r => r.provider === key.provider && r.id === key.id).map(r => r.agent),
  }));
  const missing = required.filter(key => !inventory.stored.some(
    storedKey => storedKey.provider === key.provider && storedKey.id === key.id,
  ));
  return { stored, missing };
}
function safeError(error: unknown): string { return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2000); }
