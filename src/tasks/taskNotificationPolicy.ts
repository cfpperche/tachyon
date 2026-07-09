import type { Task, TaskStatus } from "./types.js";

export const TASK_NOTIFICATION_EVENT_IDS = [
  "created",
  "assignedToMe",
  "assignedToOther",
  "statusChanged",
  "awaitingHuman",
  "journalAppended",
] as const;

export type TaskNotificationEventId = (typeof TASK_NOTIFICATION_EVENT_IDS)[number];

export interface TaskNotificationSettings {
  enabled: boolean;
  events: TaskNotificationEventId[];
  suppressOwnChanges: boolean;
  dedupeWindowMs: number;
}

export type TaskNotificationSettingsInput = Partial<TaskNotificationSettings>;

export const DEFAULT_TASK_NOTIFICATION_SETTINGS: TaskNotificationSettings = {
  enabled: true,
  events: [...TASK_NOTIFICATION_EVENT_IDS],
  suppressOwnChanges: true,
  dedupeWindowMs: 30_000,
};

export interface TaskNotificationSettingScopes {
  vscodeUser?: TaskNotificationSettingsInput;
  vscodeWorkspace?: TaskNotificationSettingsInput;
  yml?: TaskNotificationSettingsInput;
  defaults?: TaskNotificationSettings;
}

/** Resolve each key independently. Contributed VS Code defaults are intentionally not inputs here. */
export function resolveTaskNotificationSettings(scopes: TaskNotificationSettingScopes): TaskNotificationSettings {
  const dflt = scopes.defaults ?? DEFAULT_TASK_NOTIFICATION_SETTINGS;
  return {
    enabled: scopes.vscodeUser?.enabled ?? scopes.vscodeWorkspace?.enabled ?? scopes.yml?.enabled ?? dflt.enabled,
    events: [...(scopes.vscodeUser?.events ?? scopes.vscodeWorkspace?.events ?? scopes.yml?.events ?? dflt.events)],
    suppressOwnChanges: scopes.vscodeUser?.suppressOwnChanges ?? scopes.vscodeWorkspace?.suppressOwnChanges ?? scopes.yml?.suppressOwnChanges ?? dflt.suppressOwnChanges,
    dedupeWindowMs: scopes.vscodeUser?.dedupeWindowMs ?? scopes.vscodeWorkspace?.dedupeWindowMs ?? scopes.yml?.dedupeWindowMs ?? dflt.dedupeWindowMs,
  };
}

export type TaskNotificationEvent =
  | { type: "created"; task: Task; actor: string }
  | { type: "assigned"; task: Task; actor: string; from?: string; to: string }
  | { type: "statusChanged"; task: Task; actor: string; from: TaskStatus; to: TaskStatus }
  | { type: "awaitingHuman"; task: Task; actor: string; reason: string; kind: string }
  | { type: "journalAppended"; task: Task; actor: string };

export interface TaskToast {
  eventId: TaskNotificationEventId;
  message: string;
  level: "info" | "warn";
  dedupeKey: string;
}

function shortTitle(title: string): string {
  return title.length <= 120 ? title : `${title.slice(0, 119)}…`;
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

export function taskToastFor(event: TaskNotificationEvent, settings: TaskNotificationSettings, workspaceRoot: string): TaskToast | undefined {
  if (!settings.enabled) return undefined;
  const title = shortTitle(event.task.title);
  let toast: TaskToast;
  switch (event.type) {
    case "created":
      toast = { eventId: "created", message: `Task created: ${title}`, level: "info", dedupeKey: `${workspaceRoot}|created|${event.task.id}` };
      break;
    case "assigned": {
      const own = event.actor === event.to;
      if (own && settings.suppressOwnChanges) return undefined;
      toast = {
        eventId: own ? "assignedToMe" : "assignedToOther",
        message: `Task assigned to ${event.to}: ${title}`,
        level: "info",
        dedupeKey: `${workspaceRoot}|assigned|${event.task.id}|${event.to}`,
      };
      break;
    }
    case "statusChanged":
      toast = { eventId: "statusChanged", message: `Task ${event.task.id} moved to ${event.to}: ${title}`, level: "info", dedupeKey: `${workspaceRoot}|statusChanged|${event.task.id}|${event.to}` };
      break;
    case "awaitingHuman":
      toast = { eventId: "awaitingHuman", message: `Task needs you: ${title}`, level: "warn", dedupeKey: `${workspaceRoot}|awaitingHuman|${event.task.id}|${event.kind}|${hashText(event.reason)}` };
      break;
    case "journalAppended":
      toast = { eventId: "journalAppended", message: `Task note added: ${title}`, level: "info", dedupeKey: `${workspaceRoot}|journalAppended|${event.task.id}|${event.actor}` };
      break;
  }
  return settings.events.includes(toast.eventId) ? toast : undefined;
}

export class TaskNotificationDeduper {
  private readonly seen = new Map<string, number>();

  shouldNotify(key: string, windowMs: number, now = Date.now()): boolean {
    if (windowMs === 0) return true;
    for (const [candidate, timestamp] of this.seen) {
      if (now - timestamp >= windowMs) this.seen.delete(candidate);
    }
    const previous = this.seen.get(key);
    if (previous !== undefined && now - previous < windowMs) return false;
    this.seen.set(key, now);
    return true;
  }
}
