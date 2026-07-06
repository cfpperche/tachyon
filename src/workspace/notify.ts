import type { NotifyLevel } from "../bridge/tools.js";
import { notify as serviceNotify } from "./NotificationService.js";

/** One toast voice for the whole extension (and every Workspace). */
export function notify(message: string, level: NotifyLevel = "info"): void {
  serviceNotify(message, level);
}
