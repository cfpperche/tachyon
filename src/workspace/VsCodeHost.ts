import * as vscode from "vscode";
import type { NotifyLevel } from "../bridge/tools.js";
import type { EngineHost, HostDisposable, LayoutSnapshot, PromptInputOptions, ViewKind, WatchEvents } from "./EngineHost.js";

/**
 * spec 233 — the VS Code implementation of `EngineHost`. The ONLY place the engine's host touchpoints
 * (toasts, prompts, file watchers, settings, global storage, editor layout, i18n) bind to `vscode`.
 * A different shell ships its own EngineHost; the engine (Workspace + managers) is unchanged.
 */
export class VsCodeHost implements EngineHost {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly viewsChanged: (view: ViewKind) => void,
  ) {}

  t(message: string, ...args: (string | number | boolean)[]): string {
    return vscode.l10n.t(message, ...args);
  }

  notify(message: string, level: NotifyLevel = "info"): void {
    const show =
      level === "error"
        ? vscode.window.showErrorMessage
        : level === "warn"
          ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage;
    void show(`Tachyon: ${message}`);
  }

  async confirm(message: string, ...actions: string[]): Promise<string | undefined> {
    return vscode.window.showWarningMessage(message, { modal: true }, ...actions);
  }

  async promptInput(opts: PromptInputOptions): Promise<string | undefined> {
    return vscode.window.showInputBox(opts);
  }

  watch(root: string, glob: string, events: WatchEvents, onEvent: () => void): HostDisposable {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, glob));
    if (events.create !== false) watcher.onDidCreate(onEvent);
    if (events.change !== false) watcher.onDidChange(onEvent);
    if (events.delete !== false) watcher.onDidDelete(onEvent);
    return watcher;
  }

  getSetting<T>(section: string, key: string, dflt: T): T {
    return vscode.workspace.getConfiguration(section).get<T>(key, dflt);
  }

  globalStoragePath(): string {
    return this.context.globalStorageUri.fsPath;
  }

  getState<T>(key: string): T | undefined {
    return this.context.globalState.get<T>(key);
  }

  setState(key: string, value: unknown): void {
    void this.context.globalState.update(key, value);
  }

  appVersion(): string {
    return (this.context.extension.packageJSON as { version: string }).version;
  }

  mediaPath(...segments: string[]): string {
    return vscode.Uri.joinPath(this.context.extensionUri, ...segments).fsPath;
  }

  webviewRoot(): unknown {
    return this.context.extensionUri;
  }

  async captureLayout(): Promise<LayoutSnapshot> {
    const raw = (await vscode.commands.executeCommand("vscode.getEditorLayout")) as { orientation: number; groups: unknown[] };
    const agentsByGroup = vscode.window.tabGroups.all.map((group) => {
      const tab = group.tabs.find((t) => t.label.startsWith("⚡ "));
      return tab ? tab.label.slice(2).trim() : undefined;
    });
    return { raw, agentsByGroup };
  }

  onViewsChanged(view: ViewKind): void {
    this.viewsChanged(view);
  }
}
