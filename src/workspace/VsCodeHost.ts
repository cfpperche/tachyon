import * as vscode from "vscode";
import type { NotifyLevel } from "../bridge/tools.js";
import type { EngineHost, HostDisposable, NoticeAction, ViewKind, WatchEvents } from "./EngineHost.js";
import type { TerminalPresentationOptions } from "./TerminalPresentation.js";
import { Terminals } from "../presentation/Terminals.js";
import { showNotificationActions } from "./NotificationService.js";

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
    void showNotificationActions(message, level, actions);
  }

  focusPrimaryView(): void {
    void vscode.commands.executeCommand("tachyonSidebarPrototype.focus");
  }

  openTask(wsHash: string, taskId: string): void {
    void vscode.commands.executeCommand("tachyon.openControlTask", wsHash, taskId);
  }

  executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    return Promise.resolve(vscode.commands.executeCommand(command, ...args));
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

  /**
   * t-aaad95 — the ONLY VS Code configuration Tachyon still consumes, and it is not Tachyon's:
   * the built-in Git extension's `git.path`. Tachyon's own eleven keys were removed with their
   * `contributes.configuration` block; see `src/config/globalSettings.ts`.
   */
  gitExtensionPath(): string | string[] | undefined {
    return vscode.workspace.getConfiguration("git").get<string | string[]>("path");
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

  createTerminalPresentation(options: TerminalPresentationOptions): Terminals {
    return new Terminals(options.onReveal, options.kindOf, options.manifest);
  }

  onViewsChanged(view: ViewKind): void {
    this.viewsChanged(view);
  }
}
