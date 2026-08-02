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
  restoreNoticeRoute,
  type NoticeInboxEntry,
} from "./noticeInbox.js";

export interface DaemonSettingsSnapshot {
  global?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  workspaceFolder?: Record<string, unknown>;
}

/**
 * t-aaad95 — the settings the shell may hand the persistent engine, now exactly ONE.
 *
 * Every `tachyon.*` key was removed with `contributes.configuration`; the engine reads Tachyon's own
 * settings from `tachyon.yml` and the global Tachyon file directly. `git.path` survives because it
 * belongs to the built-in Git extension, and only the shell can see it.
 *
 * The allowlist stays even at one entry, and that is deliberate: it is the fail-closed guard that
 * makes smuggling a settings key back through this door an error rather than a quiet feature. The
 * envelope shape is unchanged on purpose too — an engine ROLLBACK launches an older daemon binary
 * with options this shell wrote, and a new key there would make that older validator refuse.
 */
export const DAEMON_SETTING_KEYS = ["git.path"] as const;
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
  /** t-b51923: per-view `views-changed` coalescing window; default 250, 0 disables. */
  viewCoalesceWindowMs?: number;
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
  /** t-b51923: per-view coalescing window (ms); 0 disables and restores emit-per-call. */
  private readonly viewCoalesceWindowMs: number;
  private readonly pendingViewEmits = new Map<ViewKind, { trailing: boolean; timer: ReturnType<typeof setTimeout> | undefined }>();
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
    // 250ms: a list that repaints four times a second still reads as live to a human, and it holds a
    // 15Hz-per-agent stream to one event per window instead of one per invalidation. Tuned to the
    // measured storm, not to a round number — see `onViewsChanged`.
    this.viewCoalesceWindowMs = options.viewCoalesceWindowMs ?? 250;
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
      this.invalidateAgentsView();
      return;
    }

    const id = randomUUID();
    const registered = new Map<string, () => void | Promise<void>>();
    const publicActions = actions.map((action) => {
      const actionId = randomUUID();
      registered.set(actionId, action.run);
      // t-ee2f19 — a route is recorded only if it passes the same check a RESTORED one must pass.
      // Writing through a laxer door than the one guarding the way back would make the allowlist
      // decorative, and this is the write that produces the file the restore has to trust.
      const route = restoreNoticeRoute(action.route);
      return { id: actionId, label: action.label, ...(route ? { route } : {}) };
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
    this.invalidateAgentsView();
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
    this.invalidateAgentsView();
    return true;
  }

  markAllNoticesRead(): boolean {
    this.assertActive();
    if (this.noticeInbox.length === 0) return false;
    this.noticeInbox = [];
    this.noticeActions.clear();
    this.persistNoticeInbox();
    this.invalidateAgentsView();
    return true;
  }

  async invokeNoticeAction(noticeId: string, actionId: string): Promise<void> {
    this.assertActive();
    const action = this.noticeActions.get(noticeId)?.get(actionId) ?? this.routedAction(noticeId, actionId);
    if (!action) throw new Error("notice action is missing or already consumed");
    this.noticeActions.delete(noticeId);
    // Invoking dismisses the inbox row.
    const idx = this.noticeInbox.findIndex((row) => row.id === noticeId);
    if (idx >= 0) this.noticeInbox.splice(idx, 1);
    this.persistNoticeInbox();
    this.invalidateAgentsView();
    await action();
  }

  /**
   * t-ee2f19 — rebuild the action from its persisted route when the closure is gone.
   *
   * This is the whole point of the route: after an extension-host reload the in-memory map is empty,
   * but the notice row and its destination survived, and the item it names is still waiting. The
   * route was validated on the way in and again on the way out of `restoreNoticeInbox`; going through
   * `executeCommand` keeps it on the one door the engine already has for reaching the editor.
   */
  private routedAction(noticeId: string, actionId: string): (() => Promise<void>) | undefined {
    const route = this.noticeInbox
      .find((row) => row.id === noticeId)?.actions
      .find((action) => action.id === actionId)?.route;
    if (!route) return undefined;
    return async () => {
      await this.executeCommand(route.command, ...route.args);
    };
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

  /** Folder > workspace > global, the same precedence the shell's own reader applies. */
  gitExtensionPath(): string | string[] | undefined {
    const setting = "git.path";
    const folder = this.settings.workspaceFolder?.[setting];
    const workspace = this.settings.workspace?.[setting];
    const global = this.settings.global?.[setting];
    const value = folder !== undefined ? folder : workspace !== undefined ? workspace : global;
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value as string[];
    return undefined;
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

  /**
   * t-b51923 — the same view invalidated many times in a row costs exactly ONE event.
   *
   * Measured on 0.56.158: `views-changed` for `agents` left this method ~15 times per second PER
   * RUNNING AGENT — 28-40/s with two agents, scaling linearly, while an empty fleet produced one
   * event every 3s (the heartbeat alone). Each of those did two expensive things downstream: the
   * engine journal rewrote its whole file, and every attached VS Code window refreshed that view.
   * The workspace owner could not use the editor with more than one agent running.
   *
   * Coalescing here is LOSSLESS, and that is the whole reason it is safe: the event carries no
   * payload beyond the view's name (see `DaemonHostEvent` above). It is an invalidation, not a
   * change — it says "this view is stale", never "here is what moved". N identical invalidations
   * therefore contain exactly the information of one, and a consumer that re-reads once after the
   * last one is in the same state as a consumer that re-read after each.
   *
   * Leading edge fires IMMEDIATELY, so an isolated change (an agent stopped, a task moved) reaches
   * the UI with no added latency — only a burst is held. While a burst continues, at most one event
   * leaves per window, and the trailing edge is guaranteed: the final invalidation of a burst always
   * produces an event. Swallowing the last one would leave the view stale forever, which is worse
   * than the storm this fixes.
   */
  onViewsChanged(view: ViewKind): void {
    this.assertActive();
    if (this.viewCoalesceWindowMs <= 0) {
      this.emit({ kind: "views-changed", view, at: new Date().toISOString() });
      return;
    }
    const open = this.pendingViewEmits.get(view);
    if (open) {
      open.trailing = true; // held; the window's expiry will emit it
      return;
    }
    this.emit({ kind: "views-changed", view, at: new Date().toISOString() });
    this.openViewCoalesceWindow(view);
  }

  /**
   * t-b51923 — every internal agents-view invalidation goes through the SAME door as an external one.
   *
   * The notice paths used to call `this.emit({kind:"views-changed", view:"agents"})` directly, and
   * that is how the first attempt at this fix missed entirely: coalescing was added to
   * `onViewsChanged` and the storm was measured, unchanged, the moment the build shipped. The
   * traffic never used that door. Measured with the profiler's caller chain on the live engine:
   *
   *   append ← record ← notify ← notify ← delegableToolkit ← withDelegatedToolkit ← … ← canFork
   *
   * The duplicate-notice branch above is the sharpest case and worth naming: it exists to collapse a
   * repeated notification into ONE toast, and it did that correctly — while still paying a full view
   * invalidation, and a `persistNoticeInbox()` disk write, on every repeat. The thing built to make a
   * repeat cheap made it expensive everywhere else.
   *
   * A private helper rather than five call sites reaching for `onViewsChanged`: this is one fact —
   * "the agents view is stale" — and a sixth site added later should not have to know it must not
   * emit raw.
   */
  private invalidateAgentsView(): void {
    this.onViewsChanged("agents");
  }

  /**
   * One window per view. On expiry: emit iff something was held, and only then open the next window
   * — so a quiet view stops scheduling timers instead of ticking forever.
   */
  private openViewCoalesceWindow(view: ViewKind): void {
    const state = { trailing: false, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    state.timer = setTimeout(() => {
      this.pendingViewEmits.delete(view);
      if (this.disposed || !state.trailing) return;
      this.emit({ kind: "views-changed", view, at: new Date().toISOString() });
      this.openViewCoalesceWindow(view);
    }, this.viewCoalesceWindowMs);
    state.timer.unref?.();
    this.pendingViewEmits.set(view, state);
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
    // t-b51923 — a held trailing emit must not outlive the host: its timer would fire into a disposed
    // shell. The emit itself also checks `disposed`, because a timer can already be in the queue.
    for (const pending of this.pendingViewEmits.values()) if (pending.timer) clearTimeout(pending.timer);
    this.pendingViewEmits.clear();
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

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function assertSettingAllowed(setting: string): void {
  if (!DAEMON_SETTING_KEY_SET.has(setting)) throw new Error(`setting is not allowlisted for the daemon: ${setting}`);
}
