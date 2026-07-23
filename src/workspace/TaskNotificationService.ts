import type { TachyonConfig } from "../config/loadConfig.js";
import {
  TaskNotificationDeduper,
  resolveTaskNotificationSettings,
  taskToastFor,
  type TaskNotificationEvent,
  type TaskNotificationSettingsInput,
} from "../tasks/taskNotificationPolicy.js";
import type { EngineHost } from "./EngineHost.js";

const SETTING_KEYS = ["enabled", "events", "suppressOwnChanges", "dedupeWindowMs"] as const;

function inspectedSettings(host: EngineHost): { user?: TaskNotificationSettingsInput; workspace?: TaskNotificationSettingsInput } {
  if (!host.getSettingInspect) return {};
  const user: TaskNotificationSettingsInput = {};
  const workspace: TaskNotificationSettingsInput = {};
  for (const key of SETTING_KEYS) {
    const inspected = host.getSettingInspect<never>("tachyon", `taskNotifications.${key}`);
    const workspaceValue = inspected.workspaceFolderValue ?? inspected.workspaceValue;
    if (inspected.globalValue !== undefined) Object.assign(user, { [key]: inspected.globalValue });
    if (workspaceValue !== undefined) Object.assign(workspace, { [key]: workspaceValue });
  }
  return { user, workspace };
}

export class TaskNotificationService {
  private readonly deduper = new TaskNotificationDeduper();

  constructor(
    private readonly workspaceRoot: string,
    /** t-75fd3c — same hash Workspace.ts computes as `this.wsHash`, passed in rather than recomputed
     *  here so the "Open" action's deep link always resolves the same workspace Control already keys
     *  routes by. */
    private readonly wsHash: string,
    private readonly host: EngineHost,
    private readonly config: () => TachyonConfig | undefined,
  ) {}

  notify(event: TaskNotificationEvent): void {
    try {
      const inspected = inspectedSettings(this.host);
      const settings = resolveTaskNotificationSettings({
        vscodeUser: inspected.user,
        vscodeWorkspace: inspected.workspace,
        yml: this.config()?.settings.taskNotifications,
      });
      const toast = taskToastFor(event, settings, this.workspaceRoot);
      if (!toast || !this.deduper.shouldNotify(toast.dedupeKey, settings.dedupeWindowMs)) return;
      this.host.notify(toast.message, toast.level, [
        { label: this.host.t("Open"), run: () => this.host.openTask(this.wsHash, event.task.id) },
      ]);
    } catch {
      // Human-facing notification delivery is best-effort and must never affect a successful mutation.
    }
  }
}
