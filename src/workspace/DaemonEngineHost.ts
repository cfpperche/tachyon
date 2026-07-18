import path from "node:path";
import { randomUUID } from "node:crypto";
import type { NotifyLevel } from "../bridge/tools.js";
import { isJsonValue, type JsonValue } from "../runtime-api/extensionOperations.js";
import type { EngineUiRequestV1 } from "../engine-service/protocol.js";
import { DaemonStateStore } from "../engine-service/daemonStateStore.js";
import { PollingFileWatcher } from "../engine-service/pollingWatcher.js";
import type { EngineHost, HostDisposable, NoticeAction, ViewKind, WatchEvents } from "./EngineHost.js";
import {
  DaemonTerminalPresentation,
  type TerminalPresentation,
  type TerminalPresentationOptions,
} from "./TerminalPresentation.js";

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

export type DaemonUiRequest = EngineUiRequestV1;

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
  /** t-ec5cd2: passive info auto-complete; default 4000. Tests may lower. */
  noticePassiveAutoDismissMs?: number;
  /** t-ec5cd2: exact-duplicate collapse window; default 10000. */
  noticeDedupeWindowMs?: number;
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
  private readonly pendingNotices = new Map<string, Extract<DaemonHostEvent, { kind: "notice" }>>();
  /** t-ec5cd2 / spec 397: narrow exact-duplicate window (ms). */
  private readonly noticeDedupeWindowMs: number;
  /** t-ec5cd2 / spec 397: auto-complete passive info toasts (ms). */
  private readonly noticePassiveAutoDismissMs: number;
  private readonly recentNoticeKeys = new Map<string, { at: number; count: number }>();
  private noticePresentationActive = false;
  private terminalPresentation: DaemonTerminalPresentation | undefined;
  private disposed = false;

  constructor(private readonly options: DaemonEngineHostOptions) {
    if (!options.appVersion.trim()) throw new Error("daemon appVersion is required");
    this.store = new DaemonStateStore(options.storageRoot);
    this.settings = cloneSettings(options.settings ?? {});
    this.noticeDedupeWindowMs = options.noticeDedupeWindowMs ?? 10_000;
    this.noticePassiveAutoDismissMs = options.noticePassiveAutoDismissMs ?? 4_000;
  }

  t(message: string, ...args: (string | number | boolean)[]): string {
    return message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)] ?? ""));
  }

  notify(message: string, level: NotifyLevel = "info", actions: NoticeAction[] = []): void {
    this.assertActive();
    const normalized = normalizeNoticeMessage(message);
    const dedupeKey = `${level}\0${normalized}`;
    this.pruneRecentNoticeKeys();
    const recent = this.recentNoticeKeys.get(dedupeKey);
    if (recent) {
      recent.count += 1;
      recent.at = Date.now();
      // Exact duplicate inside the window: keep one toast / pending row; bump collapse count only.
      return;
    }
    this.recentNoticeKeys.set(dedupeKey, { at: Date.now(), count: 1 });

    const id = randomUUID();
    const registered = new Map<string, () => void | Promise<void>>();
    const publicActions = actions.map((action) => {
      const actionId = randomUUID();
      registered.set(actionId, action.run);
      return { id: actionId, label: action.label };
    });
    if (registered.size > 0) this.noticeActions.set(id, registered);
    const event: Extract<DaemonHostEvent, { kind: "notice" }> = {
      kind: "notice", id, message, level, actions: publicActions, at: new Date().toISOString(),
    };
    this.pendingNotices.set(id, event);
    while (this.pendingNotices.size > 256) {
      const oldest = this.pendingNotices.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pendingNotices.delete(oldest);
      this.noticeActions.delete(oldest);
    }
    this.emit(event);
    this.schedulePresentNextNotice();
  }

  async invokeNoticeAction(noticeId: string, actionId: string): Promise<void> {
    this.assertActive();
    const actions = this.noticeActions.get(noticeId);
    const action = actions?.get(actionId);
    if (!action) throw new Error("notice action is missing or already consumed");
    this.noticeActions.delete(noticeId);
    this.pendingNotices.delete(noticeId);
    await action();
  }

  focusPrimaryView(): void {
    this.assertActive();
    const request: DaemonUiRequest = { schemaVersion: 1, operationId: randomUUID(), kind: "focus-primary" };
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
    if (!args.every(isJsonValue)) throw new EngineUiUnavailableError("editor command arguments are not JSON-safe");
    const request: DaemonUiRequest = {
      schemaVersion: 1,
      operationId: randomUUID(),
      kind: "execute-command",
      command,
      args: cloneJson(args) as JsonValue[],
    };
    if (!this.options.requestUi) {
      this.emit({ kind: "ui-unavailable", request, at: new Date().toISOString() });
      throw new EngineUiUnavailableError();
    }
    try {
      return await this.options.requestUi(request);
    } catch (error) {
      this.emit({ kind: "ui-unavailable", request, at: new Date().toISOString() });
      throw new EngineUiUnavailableError(error instanceof Error ? error.message : String(error));
    }
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

  createTerminalPresentation(options: TerminalPresentationOptions): TerminalPresentation {
    if (this.terminalPresentation) return this.terminalPresentation;
    this.terminalPresentation = new DaemonTerminalPresentation(options, (request) => this.requestUi(request));
    return this.terminalPresentation;
  }

  /** Replays presentation work that could not be claimed while every editor shell was absent. */
  replayUiRequests(): void {
    this.assertActive();
    this.terminalPresentation?.replay();
    this.schedulePresentNextNotice();
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
    this.terminalPresentation?.dispose();
    this.terminalPresentation = undefined;
    this.noticeActions.clear();
    this.pendingNotices.clear();
    this.noticePresentationActive = false;
  }

  private emit(event: DaemonHostEvent): void {
    this.options.emit?.(event);
  }

  private requestUi(request: DaemonUiRequest): Promise<unknown> {
    return this.options.requestUi?.(request) ?? Promise.reject(new EngineUiUnavailableError());
  }

  private schedulePresentNextNotice(): void {
    queueMicrotask(() => this.presentNextNotice());
  }

  private presentNextNotice(): void {
    if (this.disposed || this.noticePresentationActive) return;
    const notice = this.pendingNotices.values().next().value as Extract<DaemonHostEvent, { kind: "notice" }> | undefined;
    if (!notice) return;
    const noticeId = notice.id;
    this.noticePresentationActive = true;
    const remaining = Math.max(0, this.pendingNotices.size - 1);
    const displayMessage = remaining > 0
      ? `${notice.message} (+${remaining} more)`
      : notice.message;
    const passive = notice.level === "info" && notice.actions.length === 0;
    const presentPromise = this.requestUi({
      schemaVersion: 1,
      operationId: randomUUID(),
      kind: "notice.present",
      noticeId,
      message: displayMessage,
      level: notice.level,
      actions: notice.actions.map((action) => ({ ...action })),
    });
    const raced = passive
      ? Promise.race([
          presentPromise,
          delay(this.noticePassiveAutoDismissMs).then(() => null as unknown),
        ])
      : presentPromise;
    void raced.then(async (choice) => {
      if (choice === null || choice === undefined) {
        this.pendingNotices.delete(noticeId);
        this.noticeActions.delete(noticeId);
        return;
      }
      if (typeof choice !== "string" || !notice.actions.some((action) => action.id === choice)) {
        throw new Error("editor shell returned an invalid notice action");
      }
      await this.invokeNoticeAction(noticeId, choice);
    }).catch(() => {
      // No shell, disconnect and timeout keep the notice pending for the next attach.
      // Passive auto-dismiss must not leave a stuck active bit: still clear below in finally.
    }).finally(() => {
      this.noticePresentationActive = false;
      // If passive timed out while VS Code toast still open, drop pending so the queue advances.
      if (passive && this.pendingNotices.has(noticeId)) {
        this.pendingNotices.delete(noticeId);
        this.noticeActions.delete(noticeId);
      }
      if (!this.pendingNotices.has(noticeId)) this.schedulePresentNextNotice();
      else if (!passive) {
        // Actionable notice failed present — leave pending for replayUiRequests.
      }
    });
  }

  private pruneRecentNoticeKeys(now = Date.now()): void {
    for (const [key, entry] of this.recentNoticeKeys) {
      if (now - entry.at > this.noticeDedupeWindowMs) this.recentNoticeKeys.delete(key);
    }
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

function normalizeNoticeMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
