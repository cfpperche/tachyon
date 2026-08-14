import * as vscode from "vscode";
import type { AgentInstanceLifetime } from "@tachyon/engine/resume/SessionLedger.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { PluginActionBroker, type PluginActionBrokerResult } from "./broker.js";
import { PluginFleetProjectionProvider } from "./projectionProvider.js";
import { loadManifest, type ViewDecl } from "@tachyon/engine/plugins/manifest.js";
import { LOCKFILE_REL_PATH, parseLockfile, type MaterializedTarget } from "@tachyon/engine/plugins/lockfile.js";
import {
  pluginFleetPresentation,
  type WorkspacePresentationTarget,
  type WorkspacePluginPresentationTarget,
} from "../../shell/WorkspacePresentation.js";
import { panelIcon } from "../../webview/shared/panelIcon.js";
import { renderWebviewShell, SHELL_BASE_STYLESHEETS } from "../../webview/shared/shell.js";
import { PLUGIN_UI_ACTION, PLUGIN_UI_ACTION_RESULT, type PluginHostBootstrap, type PluginUiActionRelayMessage } from "@tachyon/webview-ui/webview/plugin-host/relay";
import { notify } from "../../workspace/NotificationService.js";

const PLUGIN_EDITOR_VIEW_TYPE = "tachyonPluginSurface";
const PLUGIN_SIDEBAR_VIEW_TYPE = "tachyonPluginSurfaces";
type PluginShellViewType = typeof PLUGIN_EDITOR_VIEW_TYPE | typeof PLUGIN_SIDEBAR_VIEW_TYPE;

export interface InstalledPluginSurface {
  key: string;
  pluginId: string;
  viewId: string;
  title: string;
  surface: ViewDecl["surface"];
  entryFile: string;
  fleet: ViewDecl["fleet"];
  actions: string[];
  workspace: WorkspacePluginPresentationTarget;
}

interface LegacyPluginWorkspaceSource extends WorkspacePresentationTarget {
  bridge: { port?: number; url?: string };
  manager: {
    list(): Promise<Array<{
      name: string;
      kind: "agent" | "terminal";
      running: boolean;
      lifetime: AgentInstanceLifetime;
    }>>;
  };
  attentionOf(agent: string): { state: "working" | "idle" | "needs-input" | "throttled" } | undefined;
}

/** Compatibility adapter used only until extension activation switches to WorkspaceClient. */
export function legacyPluginSurfaceTarget(source: LegacyPluginWorkspaceSource): WorkspacePluginPresentationTarget {
  return {
    workspaceRoot: source.workspaceRoot,
    wsHash: source.wsHash,
    folderName: source.folderName,
    pluginFleet: async () => {
      const entries = await source.manager.list();
      return pluginFleetPresentation(
        source,
        { port: source.bridge.port, connected: !!source.bridge.url },
        entries.map((entry) => ({ ...entry, attention: source.attentionOf(entry.name)?.state })),
      );
    },
  };
}

interface PluginSurfaceSession {
  key: string;
  webview: vscode.Webview;
  broker: PluginActionBroker;
  projection: PluginFleetProjectionProvider;
  dispose(): void;
  push(): Promise<void>;
}

export class PluginSurfaceHost implements vscode.WebviewViewProvider {
  public static readonly viewType = PLUGIN_SIDEBAR_VIEW_TYPE;
  private readonly sessions = new Map<string, PluginSurfaceSession>();
  private readonly editorPanels = new Map<string, vscode.WebviewPanel>();
  private sidebarView?: vscode.WebviewView;
  private sidebarSurfaceKey?: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getWorkspaces: () => WorkspacePluginPresentationTarget[],
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.sidebarView = view;
    view.onDidDispose(() => {
      if (this.sidebarView === view) this.sidebarView = undefined;
    });
    this.renderSidebar();
  }

  openSurface(arg?: { pluginId?: string; viewId?: string; wsHash?: string } | string): void {
    const surfaces = this.installedSurfaces().filter((s) => s.surface === "editor");
    const wanted = typeof arg === "string" ? { pluginId: arg } : (arg ?? {});
    const surface =
      surfaces.find((s) => (!wanted.pluginId || s.pluginId === wanted.pluginId) && (!wanted.viewId || s.viewId === wanted.viewId) && (!wanted.wsHash || s.workspace.wsHash === wanted.wsHash)) ??
      surfaces[0];
    if (!surface) {
      notify("No plugin editor surface is installed.");
      return;
    }

    const existing = this.editorPanels.get(surface.key);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Active);
      return;
    }

    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const panel = vscode.window.createWebviewPanel(
      PLUGIN_EDITOR_VIEW_TYPE,
      surface.title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true },
    );
    panel.iconPath = panelIcon(this.extensionUri, "extensions");
    const session = this.attachWebview(PLUGIN_EDITOR_VIEW_TYPE, surface, panel.webview, () => panel.dispose());
    this.sessions.set(surface.key, session);
    this.editorPanels.set(surface.key, panel);
    panel.onDidDispose(() => {
      this.editorPanels.delete(surface.key);
      this.revoke(surface.key);
    });
    void session.push();
  }

  refreshAll(): void {
    const live = new Set(this.installedSurfaces().map((s) => s.key));
    for (const key of [...this.sessions.keys()]) {
      if (!live.has(key)) this.revoke(key);
    }
    for (const session of this.sessions.values()) void session.push();
    this.renderSidebar();
  }

  dispose(): void {
    for (const key of [...this.sessions.keys()]) this.revoke(key);
    this.sidebarView = undefined;
  }

  private renderSidebar(): void {
    const view = this.sidebarView;
    if (!view) return;
    const surface = this.installedSurfaces().find((s) => s.surface === "sidebar");
    if (!surface) {
      this.sidebarSurfaceKey = undefined;
      view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")] };
      view.webview.html = this.renderShell(PLUGIN_SIDEBAR_VIEW_TYPE, view.webview, undefined);
      return;
    }
    if (this.sidebarSurfaceKey === surface.key && this.sessions.has(surface.key)) {
      void this.sessions.get(surface.key)?.push();
      return;
    }
    if (this.sidebarSurfaceKey) this.revoke(this.sidebarSurfaceKey);
    this.sidebarSurfaceKey = surface.key;
    const session = this.attachWebview(PLUGIN_SIDEBAR_VIEW_TYPE, surface, view.webview, () => undefined);
    this.sessions.set(surface.key, session);
    void session.push();
  }

  private attachWebview(shellViewType: PluginShellViewType, surface: InstalledPluginSurface, webview: vscode.Webview, dispose: () => void): PluginSurfaceSession {
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    webview.options = { enableScripts: true, localResourceRoots: [root] };
    webview.html = this.renderShell(shellViewType, webview, surface);
    const broker = new PluginActionBroker({
      pluginId: surface.pluginId,
      sessionId: surface.key,
      allowedActions: surface.actions,
      focusAgent: (target) => {
        void vscode.commands.executeCommand("tachyon.openAgentTerminalItem", target.agent, target.wsHash);
      },
    });
    const projection = new PluginFleetProjectionProvider({ postMessage: (message) => Promise.resolve(webview.postMessage(message)) }, broker.mintHandle);
    const subscription = webview.onDidReceiveMessage((message: unknown) => {
      this.handleWebviewMessage(surface, broker, projection, webview, message);
    });
    return {
      key: surface.key,
      webview,
      broker,
      projection,
      dispose: () => {
        subscription.dispose();
        broker.expireAll();
        dispose();
      },
      push: async () => {
        projection.refresh(await surface.workspace.pluginFleet());
      },
    };
  }

  private handleWebviewMessage(surface: InstalledPluginSurface, broker: PluginActionBroker, projection: PluginFleetProjectionProvider, webview: vscode.Webview, message: unknown): void {
    projection.handleMessage(message as { type?: string } | undefined);
    if ((message as { type?: unknown } | undefined)?.type !== PLUGIN_UI_ACTION) return;
    void broker.dispatchAction(message as PluginUiActionRelayMessage as never).then((result: PluginActionBrokerResult) => {
      void webview.postMessage({ type: PLUGIN_UI_ACTION_RESULT, id: (message as { id?: unknown }).id, result });
      if (!result.ok && result.code !== "rate_limited") {
        console.warn(`[tachyon] plugin UI action rejected for ${surface.pluginId}/${surface.viewId}: ${result.code}`);
      }
    });
  }

  private renderShell(shellViewType: PluginShellViewType, webview: vscode.Webview, surface: InstalledPluginSurface | undefined): string {
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const uri = (f: string): string => webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    const bootstrap: PluginHostBootstrap | undefined = surface
      ? { pluginId: surface.pluginId, viewId: surface.viewId, title: surface.title, pluginHtml: fs.readFileSync(surface.entryFile, "utf8") }
      : undefined;
    return renderWebviewShell({
      cspSource: webview.cspSource,
      title: surface?.title ?? "Plugin Surfaces",
      styles: [...SHELL_BASE_STYLESHEETS.map(uri), uri("plugin-host.css")],
      bundle: uri("plugin-host.js"),
      mode: "live",
      surface: shellViewType,
      frameSrc: "self",
      scriptCspSource: false,
      ...(bootstrap ? { bootstrapGlobals: { __tachyonPluginHost: bootstrap } } : {}),
    });
  }

  private revoke(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    this.editorPanels.delete(key);
    if (this.sidebarSurfaceKey === key) this.sidebarSurfaceKey = undefined;
    session.dispose();
  }

  private installedSurfaces(): InstalledPluginSurface[] {
    const out: InstalledPluginSurface[] = [];
    for (const ws of this.getWorkspaces()) {
      const lockPath = path.join(ws.workspaceRoot, LOCKFILE_REL_PATH);
      if (!fs.existsSync(lockPath)) continue;
      const parsed = parseLockfile(fs.readFileSync(lockPath, "utf8"));
      if (!parsed.lockfile) continue;
      for (const [pluginId, lock] of Object.entries(parsed.lockfile.plugins)) {
        const manifestPath = path.join(ws.workspaceRoot, ".tachyon", "plugins", pluginId, "tachyon-plugin.json");
        if (!fs.existsSync(manifestPath)) continue;
        const manifest = loadManifest(fs.readFileSync(manifestPath, "utf8")).manifest;
        if (!manifest?.views?.length) continue;
        for (const target of lock.targets.filter((t): t is MaterializedTarget & { ref: string } => t.kind === "view" && typeof t.ref === "string")) {
          const decl = manifest.views.find((v) => v.id === target.ref);
          if (!decl) continue;
          const entryFile = path.join(ws.workspaceRoot, target.file);
          if (!fs.existsSync(entryFile) || path.resolve(entryFile) !== path.resolve(ws.workspaceRoot, ".tachyon", "plugins", pluginId, decl.entry)) continue;
          out.push({
            key: `${ws.wsHash}:${pluginId}:${decl.id}`,
            pluginId,
            viewId: decl.id,
            title: decl.title,
            surface: decl.surface,
            entryFile,
            fleet: decl.fleet,
            actions: decl.actions ?? [],
            workspace: ws,
          });
        }
      }
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

}
