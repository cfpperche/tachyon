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
import {
  NOTICE_INBOX_CAP,
  NOTICE_INBOX_STATE_KEY,
  noticeDedupeKey,
  restoreNoticeInbox,
  type NoticeInboxEntry,
} from "./noticeInbox.js";

export interface DaemonSettingsSnapshot {
  global?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  workspaceFolder?: Record<string, unknown>;
}

export const DAEMON_SETTING_KEYS = [
  "git.path",
  "tachyon.gitPath",
  "tachyon.maxAgents",
  "tachyon.agentMemoryMax",
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
  /** t-ec5cd2 / spec 397: narrow exact-duplicate window (ms). */
  private readonly noticeDedupeWindowMs: number;
  private readonly recentNoticeKeys = new Map<string, { at: number; count: number; inboxId?: string }>();
  /** spec 415 — oldest-first durable human attention queue. */
  private noticeInbox: NoticeInboxEntry[] = [];
  private terminalPresentation: DaemonTerminalPresentation | undefined;
  private disposed = false;

  constructor(private readonly options: DaemonEngineHostOptions) {
    if (!options.appVersion.trim()) throw new Error("daemon appVersion is required");
    this.store = new DaemonStateStore(options.storageRoot);
    this.settings = cloneSettings(options.settings ?? {});
    this.noticeDedupeWindowMs = options.noticeDedupeWindowMs ?? 10_000;
    this.noticeInbox = restoreNoticeInbox(this.store.getState<unknown>(NOTICE_INBOX_STATE_KEY));
    this.rebuildRecentNoticeKeys();
  }

  t(message: string, ...args: (string | number | boolean)[]): string {
    return message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)] ?? ""));
  }

  notify(message: string, level: NotifyLevel = "info", actions: NoticeAction[] = []): void {
    this.assertActive();
    const dedupeKey = noticeDedupeKey(level, message);
    this.pruneRecentNoticeKeys();
    const recent = this.recentNoticeKeys.get(dedupeKey);
    if (recent) {
      recent.count += 1;
      recent.at = Date.now();
      if (recent.inboxId) {
        const entry = this.noticeInbox.find((row) => row.id === recent.inboxId);
        if (entry) {
          entry.collapsedCount = recent.count;
          entry.lastOccurredAt = new Date().toISOString();
          entry.read = false;
          this.persistNoticeInbox();
        }
      }
      // Exact duplicate inside the window: keep one toast / pending row; bump collapse count only.
      this.emit({ kind: "views-changed", view: "agents", at: new Date().toISOString() });
      return;
    }

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
    this.recentNoticeKeys.set(dedupeKey, { at: Date.now(), count: 1, inboxId: id });
    this.pushInbox({
      id,
      message,
      level,
      at: event.at,
      lastOccurredAt: event.at,
      collapsedCount: 1,
      actions: publicActions.map((a) => ({ ...a })),
      read: false,
      actionsLive: publicActions.length > 0,
    });
    this.emit(event);
    this.emit({ kind: "views-changed", view: "agents", at: new Date().toISOString() });
  }

  /** Oldest-first canonical attention snapshot (spec 415). */
  listNoticeInbox(): NoticeInboxEntry[] {
    return this.noticeInbox.map((entry) => ({
      ...entry,
      actions: entry.actions.map((a) => ({ ...a })),
    }));
  }

  markNoticeRead(id: string): boolean {
    this.assertActive();
    const idx = this.noticeInbox.findIndex((row) => row.id === id);
    if (idx < 0) return false;
    // Mark-read dismisses from the catch-up strip (history not kept once acked).
    this.noticeInbox.splice(idx, 1);
    this.noticeActions.delete(id);
    this.persistNoticeInbox();
    this.emit({ kind: "views-changed", view: "agents", at: new Date().toISOString() });
    return true;
  }

  markAllNoticesRead(): boolean {
    this.assertActive();
    if (this.noticeInbox.length === 0) return false;
    this.noticeInbox = [];
    this.noticeActions.clear();
    this.persistNoticeInbox();
    this.emit({ kind: "views-changed", view: "agents", at: new Date().toISOString() });
    return true;
  }

  async invokeNoticeAction(noticeId: string, actionId: string): Promise<void> {
    this.assertActive();
    const actions = this.noticeActions.get(noticeId);
    const action = actions?.get(actionId);
    if (!action) throw new Error("notice action is missing or already consumed");
    this.noticeActions.delete(noticeId);
    // Invoking dismisses the inbox row.
    const idx = this.noticeInbox.findIndex((row) => row.id === noticeId);
    if (idx >= 0) this.noticeInbox.splice(idx, 1);
    this.persistNoticeInbox();
    this.emit({ kind: "views-changed", view: "agents", at: new Date().toISOString() });
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

  // t-75fd3c — reuses the existing generic "execute-command" UI request (same one executeCommand()
  // below sends) rather than adding a new DaemonUiRequest variant: the shell-side command already
  // exists (tachyon.openControlTask), and openTask is best-effort/void like focusPrimaryView, not
  // throwing like executeCommand does on failure.
  openTask(wsHash: string, taskId: string): void {
    this.assertActive();
    const request: DaemonUiRequest = {
      schemaVersion: 1,
      operationId: randomUUID(),
      kind: "execute-command",
      command: "tachyon.openControlTask",
      args: [wsHash, taskId],
    };
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
  }

  private emit(event: DaemonHostEvent): void {
    this.options.emit?.(event);
  }

  private requestUi(request: DaemonUiRequest): Promise<unknown> {
    return this.options.requestUi?.(request) ?? Promise.reject(new EngineUiUnavailableError());
  }

  private pushInbox(entry: NoticeInboxEntry): void {
    this.noticeInbox.push(entry);
    while (this.noticeInbox.length > NOTICE_INBOX_CAP) {
      const dropped = this.noticeInbox.shift();
      if (dropped) this.noticeActions.delete(dropped.id);
    }
    this.persistNoticeInbox();
  }

  private persistNoticeInbox(): void {
    this.store.setState(NOTICE_INBOX_STATE_KEY, this.noticeInbox);
  }

  private rebuildRecentNoticeKeys(now = Date.now()): void {
    for (const entry of this.noticeInbox) {
      const at = Date.parse(entry.lastOccurredAt ?? entry.at);
      if (!Number.isFinite(at) || now - at > this.noticeDedupeWindowMs) continue;
      this.recentNoticeKeys.set(noticeDedupeKey(entry.level, entry.message), {
        at,
        count: entry.collapsedCount,
        inboxId: entry.id,
      });
    }
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
