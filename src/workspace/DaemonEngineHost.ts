import path from "node:path";
import { randomUUID } from "node:crypto";
import type { NotifyLevel } from "../bridge/tools.js";
import { DaemonStateStore } from "../engine-service/daemonStateStore.js";
import { PollingFileWatcher } from "../engine-service/pollingWatcher.js";
import type { EngineHost, HostDisposable, NoticeAction, ViewKind, WatchEvents } from "./EngineHost.js";
import { HeadlessTerminalPresentation, type TerminalPresentation } from "./TerminalPresentation.js";

export interface DaemonSettingsSnapshot {
  global?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  workspaceFolder?: Record<string, unknown>;
}

export const DAEMON_SETTING_KEYS = [
  "git.path",
  "tachyon.gitPath",
  "tachyon.maxAgents",
  "tachyon.taskNotifications.enabled",
  "tachyon.taskNotifications.events",
  "tachyon.taskNotifications.suppressOwnChanges",
  "tachyon.taskNotifications.dedupeWindowMs",
] as const;
const DAEMON_SETTING_KEY_SET = new Set<string>(DAEMON_SETTING_KEYS);

export type DaemonUiRequest =
  | { id: string; kind: "focus-primary" }
  | { id: string; kind: "execute-command"; command: string; args: unknown[] };

export type DaemonHostEvent =
  | { kind: "views-changed"; view: ViewKind; at: string }
  | { kind: "activity-appended"; agent: string; count: number; at: string }
  | { kind: "notice"; id: string; message: string; level: NotifyLevel; actions: Array<{ id: string; label: string }>; at: string }
  | { kind: "ui-unavailable"; request: DaemonUiRequest; at: string };

export interface DaemonEngineHostOptions {
  storageRoot: string;
  mediaRoot: string;
  appVersion: string;
  settings?: DaemonSettingsSnapshot;
  emit?: (event: DaemonHostEvent) => void;
  requestUi?: (request: DaemonUiRequest) => Promise<unknown>;
  watchIntervalMs?: number;
  watchMaxEntries?: number;
}

export class EngineUiUnavailableError extends Error {
  readonly code = "UI_UNAVAILABLE";
  constructor(message = "no capable Tachyon shell is attached") {
    super(message);
    this.name = "EngineUiUnavailableError";
  }
}

export class DaemonEngineHost implements EngineHost {
  private readonly store: DaemonStateStore;
  private settings: DaemonSettingsSnapshot;
  private readonly watchers = new Set<HostDisposable>();
  private readonly noticeActions = new Map<string, Map<string, () => void | Promise<void>>>();
  private disposed = false;

  constructor(private readonly options: DaemonEngineHostOptions) {
    if (!options.appVersion.trim()) throw new Error("daemon appVersion is required");
    this.store = new DaemonStateStore(options.storageRoot);
    this.settings = cloneSettings(options.settings ?? {});
  }

  t(message: string, ...args: (string | number | boolean)[]): string {
    return message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)] ?? ""));
  }

  notify(message: string, level: NotifyLevel = "info", actions: NoticeAction[] = []): void {
    this.assertActive();
    const id = randomUUID();
    const registered = new Map<string, () => void | Promise<void>>();
    const publicActions = actions.map((action) => {
      const actionId = randomUUID();
      registered.set(actionId, action.run);
      return { id: actionId, label: action.label };
    });
    if (registered.size > 0) {
      this.noticeActions.set(id, registered);
      while (this.noticeActions.size > 256) {
        const oldest = this.noticeActions.keys().next().value as string | undefined;
        if (!oldest) break;
        this.noticeActions.delete(oldest);
      }
    }
    this.emit({ kind: "notice", id, message, level, actions: publicActions, at: new Date().toISOString() });
  }

  async invokeNoticeAction(noticeId: string, actionId: string): Promise<void> {
    this.assertActive();
    const actions = this.noticeActions.get(noticeId);
    const action = actions?.get(actionId);
    if (!action) throw new Error("notice action is missing or already consumed");
    this.noticeActions.delete(noticeId);
    await action();
  }

  focusPrimaryView(): void {
    this.assertActive();
    const request: DaemonUiRequest = { id: randomUUID(), kind: "focus-primary" };
    if (!this.options.requestUi) {
      this.emit({ kind: "ui-unavailable", request, at: new Date().toISOString() });
      return;
    }
    void this.options.requestUi(request).catch(() => {
      this.emit({ kind: "ui-unavailable", request, at: new Date().toISOString() });
    });
  }

  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    this.assertActive();
    const request: DaemonUiRequest = { id: randomUUID(), kind: "execute-command", command, args };
    if (!this.options.requestUi) {
      this.emit({ kind: "ui-unavailable", request, at: new Date().toISOString() });
      throw new EngineUiUnavailableError();
    }
    return this.options.requestUi(request);
  }

  watch(root: string, glob: string, events: WatchEvents, onEvent: () => void): HostDisposable {
    this.assertActive();
    const watcher = new PollingFileWatcher(root, glob, events, onEvent, {
      intervalMs: this.options.watchIntervalMs,
      maxEntries: this.options.watchMaxEntries,
      onError: (error) => {
        if (!this.disposed) this.notify(`file watch failed for '${glob}': ${error.message}`, "warn");
      },
    });
    const disposable: HostDisposable = {
      dispose: () => {
        watcher.dispose();
        this.watchers.delete(disposable);
      },
    };
    this.watchers.add(disposable);
    return disposable;
  }

  replaceSettings(settings: DaemonSettingsSnapshot): void {
    this.assertActive();
    this.settings = cloneSettings(settings);
  }

  getSetting<T>(section: string, key: string, dflt: T): T {
    const setting = `${section}.${key}`;
    assertSettingAllowed(setting);
    const folder = this.settings.workspaceFolder?.[setting];
    const workspace = this.settings.workspace?.[setting];
    const global = this.settings.global?.[setting];
    const value = folder !== undefined ? folder : workspace !== undefined ? workspace : global;
    return value === undefined ? dflt : cloneJson(value) as T;
  }

  getSettingInspect<T>(section: string, key: string): { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } {
    const setting = `${section}.${key}`;
    assertSettingAllowed(setting);
    return {
      globalValue: cloneOptional<T>(this.settings.global?.[setting]),
      workspaceValue: cloneOptional<T>(this.settings.workspace?.[setting]),
      workspaceFolderValue: cloneOptional<T>(this.settings.workspaceFolder?.[setting]),
    };
  }

  globalStoragePath(): string { return this.store.root; }
  getState<T>(key: string): T | undefined { return this.store.getState<T>(key); }
  setState(key: string, value: unknown): void { this.store.setState(key, value); }
  getSecret(key: string): Promise<string | undefined> { return Promise.resolve(this.store.getSecret(key)); }
  setSecret(key: string, value: string): Promise<void> { this.store.setSecret(key, value); return Promise.resolve(); }
  appVersion(): string { return this.options.appVersion; }

  mediaPath(...segments: string[]): string {
    const resolved = path.resolve(this.options.mediaRoot, ...segments);
    const relative = path.relative(path.resolve(this.options.mediaRoot), resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("daemon media path escapes its bundle");
    return resolved;
  }

  webviewRoot(): unknown { return undefined; }

  createTerminalPresentation(): TerminalPresentation {
    return new HeadlessTerminalPresentation();
  }

  onViewsChanged(view: ViewKind): void {
    this.assertActive();
    this.emit({ kind: "views-changed", view, at: new Date().toISOString() });
  }

  onActivityAppended(agent: string, count: number): void {
    this.assertActive();
    this.emit({ kind: "activity-appended", agent, count, at: new Date().toISOString() });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers.clear();
    this.noticeActions.clear();
  }

  private emit(event: DaemonHostEvent): void {
    this.options.emit?.(event);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("daemon engine host is disposed");
  }
}

function cloneSettings(settings: DaemonSettingsSnapshot): DaemonSettingsSnapshot {
  return {
    global: cloneRecord(settings.global),
    workspace: cloneRecord(settings.workspace),
    workspaceFolder: cloneRecord(settings.workspaceFolder),
  };
}

function cloneRecord(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  for (const key of Object.keys(value)) assertSettingAllowed(key);
  return cloneJson(value) as Record<string, unknown>;
}

function cloneOptional<T>(value: unknown): T | undefined {
  return value === undefined ? undefined : cloneJson(value) as T;
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function assertSettingAllowed(setting: string): void {
  if (!DAEMON_SETTING_KEY_SET.has(setting)) throw new Error(`setting is not allowlisted for the daemon: ${setting}`);
}
