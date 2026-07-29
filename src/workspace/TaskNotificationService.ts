import type { TachyonConfig } from "../config/loadConfig.js";
import {
  TaskNotificationDeduper,
  resolveTaskNotificationSettings,
  taskToastFor,
  type TaskNotificationEvent,
} from "../tasks/taskNotificationPolicy.js";
import type { EngineHost } from "./EngineHost.js";

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
      // t-aaad95 — `tachyon.yml` is the only authority. The four `tachyon.taskNotifications.*` VS Code
      // keys and the scope-inspection port that read them were removed together.
      const settings = resolveTaskNotificationSettings({ yml: this.config()?.settings.taskNotifications });
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
