import * as vscode from "vscode";
import type { NotifyLevel } from "../bridge/tools.js";
import type { EngineHost, HostDisposable, NoticeAction, ViewKind, WatchEvents } from "./EngineHost.js";

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

  notify(message: string, level: NotifyLevel = "info", actions: NoticeAction[] = []): void {
    const show =
      level === "error"
        ? vscode.window.showErrorMessage
        : level === "warn"
          ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage;
    void show(`Tachyon: ${message}`, ...actions.map((a) => a.label)).then((choice) => {
      const picked = actions.find((a) => a.label === choice);
      if (picked) void picked.run();
    });
  }

  focusPrimaryView(): void {
    void vscode.commands.executeCommand("tachyonSidebarPrototype.focus");
  }

  watch(root: string, glob: string, events: WatchEvents, onEvent: () => void): HostDisposable {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, glob));
    // opt-in: only subscribe to the events explicitly requested (omitted = OFF), matching the pre-233
    // wiring (e.g. the config watcher listens to change+create, NOT delete).
    if (events.create) watcher.onDidCreate(onEvent);
    if (events.change) watcher.onDidChange(onEvent);
    if (events.delete) watcher.onDidDelete(onEvent);
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

  getSecret(key: string): Promise<string | undefined> {
    return Promise.resolve(this.context.secrets.get(key));
  }

  setSecret(key: string, value: string): Promise<void> {
    return Promise.resolve(this.context.secrets.store(key, value));
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

  onViewsChanged(view: ViewKind): void {
    this.viewsChanged(view);
  }
}
