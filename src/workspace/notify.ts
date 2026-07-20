import * as vscode from "vscode";
import type { NotifyLevel } from "../bridge/tools.js";
import {
  notify as serviceNotify,
  setNotificationProvider,
  type NotificationRequest,
  type UiNotificationPort,
} from "./NotificationService.js";

const STATUS_FEEDBACK_MS = 8_000;

/** spec 415 — modal safety stays native; every non-modal path avoids Notification Center. */
class VsCodeNotificationProvider implements UiNotificationPort {
  async notify(request: NotificationRequest): Promise<string | undefined> {
    const level = request.level ?? "info";
    const message = request.prefix === false ? request.message : `Tachyon: ${request.message}`;
    const labels = (request.actions ?? []).map((action) => action.label);
    if (request.modal === true) {
      const options: vscode.MessageOptions = {
        modal: true,
        ...(request.detail !== undefined ? { detail: request.detail } : {}),
      };
      switch (level) {
        case "error":
          return vscode.window.showErrorMessage(message, options, ...labels);
        case "warn":
          return vscode.window.showWarningMessage(message, options, ...labels);
        default:
          return vscode.window.showInformationMessage(message, options, ...labels);
      }
    }

    if (labels.length > 0) {
      return vscode.window.showQuickPick(labels, {
        title: message,
        ...(request.detail !== undefined ? { placeHolder: request.detail } : {}),
        ignoreFocusOut: true,
      });
    }

    vscode.window.setStatusBarMessage(statusMessage(message, level), STATUS_FEEDBACK_MS);
    return undefined;
  }
}

/** Bind the extension-wide modal/status/QuickPick service to the VS Code shell at activation. */
export function initializeVsCodeNotifications(): void {
  setNotificationProvider(new VsCodeNotificationProvider());
}

/** One toast voice for the whole extension (and every Workspace). */
export function notify(message: string, level: NotifyLevel = "info"): void {
  serviceNotify(message, level);
}

function statusMessage(message: string, level: NotifyLevel): string {
  if (level === "error") return `$(error) ${message}`;
  if (level === "warn") return `$(warning) ${message}`;
  return `$(info) ${message}`;
}
