import type { Task, TaskStatus } from "./types.js";

export const TASK_NOTIFICATION_EVENT_IDS = [
  "created",
  "assigned",
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
  yml?: TaskNotificationSettingsInput;
  defaults?: TaskNotificationSettings;
}

/**
 * Resolve each key independently against the product default.
 *
 * t-aaad95 — `tachyon.yml` is the ONLY scope. This used to merge two VS Code scopes over it; those
 * keys were removed with `contributes.configuration`, so what is left is the per-key default fill,
 * which still has to happen somewhere because `settings.taskNotifications` is a partial mapping.
 */
export function resolveTaskNotificationSettings(scopes: TaskNotificationSettingScopes): TaskNotificationSettings {
  const dflt = scopes.defaults ?? DEFAULT_TASK_NOTIFICATION_SETTINGS;
  return {
    enabled: scopes.yml?.enabled ?? dflt.enabled,
    events: [...(scopes.yml?.events ?? dflt.events)],
    suppressOwnChanges: scopes.yml?.suppressOwnChanges ?? dflt.suppressOwnChanges,
    dedupeWindowMs: scopes.yml?.dedupeWindowMs ?? dflt.dedupeWindowMs,
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

/**
 * t-18a658 — an agent-caused toast must say WHICH agent caused it. `actor` is the Bridge-resolved
 * caller: an agent name, or a principal kind ("human", "master", "external", "legacy") for
 * non-agent callers — those keep the anonymous phrasing the human already reads as "not an agent".
 */
const NON_AGENT_ACTORS = new Set(["human", "master", "external", "legacy", "agent", ""]);

function byActor(actor: string): string {
  return NON_AGENT_ACTORS.has(actor) ? "" : ` by ${actor}`;
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
      toast = { eventId: "created", message: `Task created${byActor(event.actor)}: ${title}`, level: "info", dedupeKey: `${workspaceRoot}|created|${event.task.id}` };
      break;
    case "assigned": {
      const own = event.actor === event.to;
      if (own && settings.suppressOwnChanges) return undefined;
      // Human-facing v1 toasts observe Bridge/agent task mutations only. Any non-self assignment
      // is a fleet-visible assignment event; the assignee agent still gets its separate pane notice.
      toast = {
        eventId: "assigned",
        message: `Task assigned to ${event.to}${event.actor === event.to ? "" : byActor(event.actor)}: ${title}`,
        level: "info",
        dedupeKey: `${workspaceRoot}|assigned|${event.task.id}|${event.to}`,
      };
      break;
    }
    case "statusChanged":
      toast = { eventId: "statusChanged", message: `Task ${event.task.id} moved to ${event.to}${byActor(event.actor)}: ${title}`, level: "info", dedupeKey: `${workspaceRoot}|statusChanged|${event.task.id}|${event.to}` };
      break;
    case "awaitingHuman":
      toast = { eventId: "awaitingHuman", message: `Task needs you${byActor(event.actor).replace(" by ", " — flagged by ")}: ${title}`, level: "warn", dedupeKey: `${workspaceRoot}|awaitingHuman|${event.task.id}|${event.kind}|${hashText(event.reason)}` };
      break;
    case "journalAppended":
      toast = { eventId: "journalAppended", message: `Task note added${byActor(event.actor)}: ${title}`, level: "info", dedupeKey: `${workspaceRoot}|journalAppended|${event.task.id}|${event.actor}` };
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

/**
 * t-57a00a — WHAT the assignee agent should be woken about, decided from the mutation alone.
 *
 * The wake-up line already existed, but it hung off the Bridge's `update_task` handler, so an agent
 * assigning to another agent notified and a human assigning in the UI did not — and the UI is the
 * common case. Four writers reach `TaskStore.update` directly (TaskDetailTarget, MissionControlTarget,
 * taskStudioService, engineService) and none of them passed through that handler.
 *
 * So the decision moves here, as a pure function over before/after, and the caller that runs it is the
 * store's mutation sink — the one place every writer must cross. See t-b4a799: the durable fix for a
 * two-path mechanism is to hang the behaviour where the paths converge, not to copy it into each one.
 *
 * TWO triggers, because the human's question had two halves and only one was ever answered:
 *   - the task became yours (assignee changed to you)
 *   - your task became executable (status moved to `active` while assigned to you)
 * A task landing straight in `active` with an assignee fires once, not twice.
 *
 * `actor` keeps spec 351's self-assign suppression: picking up your own work is not news. It is
 * optional because the UI has no agent caller — a human acting is never the assignee.
 */
export interface TaskAssigneeWake {
  assignee: string;
  line: string;
}

export function taskAssigneeWakeFor(
  event: { before: Task; after: Task; actor?: string },
  taskUrl: (id: string) => string = (id) => `get_task("${id}")`,
): TaskAssigneeWake | undefined {
  const assignee = event.after.assignee;
  if (!assignee || assignee === event.actor) return undefined;
  const becameMine = assignee !== event.before.assignee;
  const becameActive = event.after.status === "active" && event.before.status !== "active";
  if (!becameMine && !becameActive) return undefined;
  // Assigned-and-activated in one patch is one event: the task is yours and it is startable.
  const reason = becameMine ? "assigned to you" : "now active and assigned to you";
  return {
    assignee,
    line: `[tachyon] task ${event.after.id} ${reason}: ${event.after.title}. Open it with ${taskUrl(event.after.id)} and begin it.`,
  };
}
