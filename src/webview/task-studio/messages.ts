/**
 * spec 339 — the SHARED host↔webview envelope for the Task Studio view, mirroring pin-studio's convention
 * (messages.ts adds constructors at the host's message-creation boundary; the webview's inbound action set
 * stays a typed union, no per-action constructors — the dueto's "boundary shape + exhaustiveness").
 */

import type { TaskStudioHostMessage, TaskStudioVM } from "./types.js";
import type { RichDocAttachmentVM } from "../rich-doc/types.js";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready.js";
export type { TaskStudioHostMessage, TaskStudioWebviewMessage } from "./types.js";

export const taskStudioMessage = (vm: TaskStudioVM): TaskStudioHostMessage => ({ type: "taskStudio", vm });
export const attachmentStoredMessage = (attachment: RichDocAttachmentVM): TaskStudioHostMessage => ({ type: "attachmentStored", attachment });
export const errorMessage = (message: string): TaskStudioHostMessage => ({ type: "error", message });
export const saveConflictMessage = (message: string): TaskStudioHostMessage => ({ type: "saveConflict", message });
