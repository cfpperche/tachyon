import * as vscode from "vscode";
import type { NotifyLevel } from "@tachyon/engine/workspace/EngineHost.js";
import {
  notify as serviceNotify,
  setNotificationProvider,
  type NotificationRequest,
  type UiNotificationPort,
} from "./NotificationService.js";

export type StatusNoticePush = (message: string, level: NotifyLevel) => Promise<void>;

/** spec 415 — modal safety stays native; ordinary non-modal paths avoid Notification Center. */
class VsCodeNotificationProvider implements UiNotificationPort {
  constructor(private readonly pushStatusNotice: StatusNoticePush) {}

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

    // t-be359b — STAYS NATIVE, deliberately; this is not an oversight of the picker sweep.
    // This is not "a picker" but how spec 415 renders a NOTIFICATION WITH ACTIONS without going
    // through Notification Center, and every showNotification(...) with actions in the extension
    // lands here — commands, background flows, workspace events, with no window focus guaranteed
    // and no surface of ours necessarily on screen. A product picker needs somewhere to draw;
    // this caller cannot promise one. Replacing it is a change to spec 415's notification
    // authority, not a picker swap.
    if (labels.length > 0) {
      return vscode.window.showQuickPick(labels, {
        title: message,
        ...(request.detail !== undefined ? { placeHolder: request.detail } : {}),
        ignoreFocusOut: true,
      });
    }

    try {
      await this.pushStatusNotice(message, level);
    } catch (error) {
      // SDD 512 / t-147361 fatia A mould: the secondary write may fail, but the fact must not
      // disappear. The native non-modal notice is an explicit degradation path, not the ordinary
      // notification authority; using this same provider again would recurse into the failed write.
      console.error(`[tachyon] sidebar status notice delivery failed: ${error instanceof Error ? error.message : String(error)}`);
      if (level === "error") await vscode.window.showErrorMessage(message);
      else if (level === "warn") await vscode.window.showWarningMessage(message);
      else await vscode.window.showInformationMessage(message);
    }
    return undefined;
  }
}

/** Bind the extension-wide modal/status/QuickPick service to the VS Code shell at activation. */
export function initializeVsCodeNotifications(pushStatusNotice: StatusNoticePush = () => Promise.reject(new Error("no workspace engine is attached"))): void {
  setNotificationProvider(new VsCodeNotificationProvider(pushStatusNotice));
}

/** One toast voice for the whole extension (and every Workspace). */
export function notify(message: string, level: NotifyLevel = "info"): void {
  serviceNotify(message, level);
}
