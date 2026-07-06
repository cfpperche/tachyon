import * as vscode from "vscode";
import type { NotifyLevel } from "../bridge/tools.js";
import type { NoticeAction } from "./EngineHost.js";

export interface NotificationOptions {
  modal?: boolean;
  detail?: string;
  /** Defaults to true so Tachyon notices keep a consistent product prefix. */
  prefix?: boolean;
}

export interface NotificationAction {
  label: string;
  run?: () => void | Promise<void>;
}

export interface NotificationRequest extends NotificationOptions {
  message: string;
  level?: NotifyLevel;
  actions?: readonly NotificationAction[];
}

export interface UiNotificationPort {
  notify(request: NotificationRequest): Promise<string | undefined>;
}

export class NativeVsCodeNotificationProvider implements UiNotificationPort {
  async notify(request: NotificationRequest): Promise<string | undefined> {
    const level = request.level ?? "info";
    const message = request.prefix === false ? request.message : `Tachyon: ${request.message}`;
    const labels = (request.actions ?? []).map((a) => a.label);
    return showNative(level, message, labels, request);
  }
}

export class NotificationService {
  constructor(private provider: UiNotificationPort = new NativeVsCodeNotificationProvider()) {}

  setProvider(provider: UiNotificationPort): void {
    this.provider = provider;
  }

  notify(message: string, level: NotifyLevel = "info", options: NotificationOptions = {}): void {
    void this.show(message, level, [], options);
  }

  show<T extends string>(
    message: string,
    level: NotifyLevel = "info",
    actions: readonly T[] = [],
    options: NotificationOptions = {},
  ): Promise<T | undefined> {
    return this.dispatch({
      ...options,
      message,
      level,
      actions: actions.map((label) => ({ label })),
    }).then((choice) => choice as T | undefined);
  }

  showActions(message: string, level: NotifyLevel = "info", actions: readonly NoticeAction[] = [], options: NotificationOptions = {}): Promise<string | undefined> {
    return this.dispatch({ ...options, message, level, actions });
  }

  private async dispatch(request: NotificationRequest): Promise<string | undefined> {
    const choice = await this.provider.notify(request);
    const picked = request.actions?.find((a) => a.label === choice);
    if (picked?.run) await picked.run();
    return choice;
  }
}

export const notificationService = new NotificationService();

export function setNotificationProvider(provider: UiNotificationPort): void {
  notificationService.setProvider(provider);
}

export function notify(message: string, level: NotifyLevel = "info", options: NotificationOptions = {}): void {
  notificationService.notify(message, level, options);
}

export function showNotification<T extends string>(
  message: string,
  level: NotifyLevel = "info",
  actions: readonly T[] = [],
  options: NotificationOptions = {},
): Promise<T | undefined> {
  return notificationService.show(message, level, actions, options);
}

export function showNotificationActions(
  message: string,
  level: NotifyLevel = "info",
  actions: readonly NoticeAction[] = [],
  options: NotificationOptions = {},
): Promise<string | undefined> {
  return notificationService.showActions(message, level, actions, options);
}

function showNative(level: NotifyLevel, message: string, labels: string[], options: NotificationOptions): Thenable<string | undefined> {
  const messageOptions = nativeMessageOptions(options);
  if (messageOptions) {
    switch (level) {
      case "error":
        return vscode.window.showErrorMessage(message, messageOptions, ...labels);
      case "warn":
        return vscode.window.showWarningMessage(message, messageOptions, ...labels);
      default:
        return vscode.window.showInformationMessage(message, messageOptions, ...labels);
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

function nativeMessageOptions(options: NotificationOptions): vscode.MessageOptions | undefined {
  if (options.modal === undefined && options.detail === undefined) return undefined;
  return {
    ...(options.modal !== undefined ? { modal: options.modal } : {}),
    ...(options.detail !== undefined ? { detail: options.detail } : {}),
  };
}
