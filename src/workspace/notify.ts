import * as vscode from "vscode";
import type { NotifyLevel } from "../bridge/tools.js";
import {
  notify as serviceNotify,
  setNotificationProvider,
  type NotificationOptions,
  type NotificationRequest,
  type UiNotificationPort,
} from "./NotificationService.js";

class NativeVsCodeNotificationProvider implements UiNotificationPort {
  async notify(request: NotificationRequest): Promise<string | undefined> {
    const level = request.level ?? "info";
    const message = request.prefix === false ? request.message : `Tachyon: ${request.message}`;
    const labels = (request.actions ?? []).map((action) => action.label);
    const options = nativeMessageOptions(request);
    if (options) {
      switch (level) {
        case "error":
          return vscode.window.showErrorMessage(message, options, ...labels);
        case "warn":
          return vscode.window.showWarningMessage(message, options, ...labels);
        default:
          return vscode.window.showInformationMessage(message, options, ...labels);
      }
    }
    switch (level) {
      case "error":
        return vscode.window.showErrorMessage(message, ...labels);
      case "warn":
        return vscode.window.showWarningMessage(message, ...labels);
      default:
        return vscode.window.showInformationMessage(message, ...labels);
    }
  }
}

/** Bind the extension-wide notification service to the VS Code shell at activation. */
export function initializeNativeNotifications(): void {
  setNotificationProvider(new NativeVsCodeNotificationProvider());
}

/** One toast voice for the whole extension (and every Workspace). */
export function notify(message: string, level: NotifyLevel = "info"): void {
  serviceNotify(message, level);
}

function nativeMessageOptions(options: NotificationOptions): vscode.MessageOptions | undefined {
  if (options.modal === undefined && options.detail === undefined) return undefined;
  return {
    ...(options.modal !== undefined ? { modal: options.modal } : {}),
    ...(options.detail !== undefined ? { detail: options.detail } : {}),
  };
}
