import * as vscode from "vscode";
import { emptyRuntimeOpsSnapshot, type RuntimeOpsSnapshotV1 } from "../runtimeOps/types.js";
import { renderWebviewShell } from "./shared/shell.js";
import { READY } from "./shared/ready.js";
import {
  runtimeOpsSnapshotMessage,
  runtimeOpsSnapshotUnavailableMessage,
  type RuntimeOpsSnapshotMessage,
} from "./runtime-ops/messages.js";

export type RuntimeOpsSnapshotBuilder = () => RuntimeOpsSnapshotV1 | Promise<RuntimeOpsSnapshotV1>;

export class RuntimeOpsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "tachyonRuntimeOpsView";
  private view?: vscode.WebviewView;
  private renderToken = 0;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private retainedFailure?: RuntimeOpsSnapshotMessage;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly buildSnapshot: RuntimeOpsSnapshotBuilder = emptyRuntimeOpsSnapshot,
    private readonly coalesceMs = 75,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const uri = (file: string): string => view.webview.asWebviewUri(vscode.Uri.joinPath(root, file)).toString();
    view.webview.options = {
      enableScripts: true,
      enableCommandUris: ["tachyon.refreshRuntimeOps"],
      localResourceRoots: [root],
    };
    view.webview.html = renderWebviewShell({
      cspSource: view.webview.cspSource,
      title: "Runtime Ops",
      styles: [uri("design-system.css"), uri("runtime-ops.css")],
      bundle: uri("runtime-ops.js"),
      mode: "live",
      scriptCspSource: false,
    });

    const ready = view.webview.onDidReceiveMessage((message: { type?: string } | undefined) => {
      if (message?.type === READY) {
        if (this.retainedFailure) void this.publishRetainedFailure(view);
        else void this.push(view);
      }
    });
    const visibility = view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.clearRefreshTimer();
        void this.push(view);
      }
    });
    view.onDidDispose(() => {
      ready.dispose();
      visibility.dispose();
      if (this.view === view) this.view = undefined;
      this.clearRefreshTimer();
      this.renderToken += 1;
    });
  }

  refresh(): void {
    const view = this.view;
    if (!view?.visible || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.view === view && view.visible) void this.push(view);
    }, this.coalesceMs);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private async push(view: vscode.WebviewView): Promise<void> {
    if (this.view !== view || !view.visible) return;
    const token = ++this.renderToken;
    let message: RuntimeOpsSnapshotMessage;
    try {
      message = runtimeOpsSnapshotMessage(await this.buildSnapshot());
    } catch {
      if (!this.isCurrent(view, token)) return;
      message = runtimeOpsSnapshotUnavailableMessage();
      this.retainedFailure = message;
    }
    if (!this.isCurrent(view, token)) return;
    const delivered = await this.post(view, message, token);
    if (!this.isCurrent(view, token)) return;
    if (delivered) this.retainedFailure = undefined;
  }

  private async publishRetainedFailure(view: vscode.WebviewView): Promise<void> {
    const message = this.retainedFailure;
    if (!message || this.view !== view || !view.visible) return;
    const token = ++this.renderToken;
    const delivered = await this.post(view, message, token);
    if (!this.isCurrent(view, token)) return;
    if (delivered && this.retainedFailure === message) this.retainedFailure = undefined;
  }

  private isCurrent(view: vscode.WebviewView, token: number): boolean {
    return this.view === view && view.visible && token === this.renderToken;
  }

  private async post(view: vscode.WebviewView, message: RuntimeOpsSnapshotMessage, token: number): Promise<boolean> {
    if (!this.isCurrent(view, token)) return false;
    try {
      const delivered = await view.webview.postMessage(message);
      return delivered && this.isCurrent(view, token);
    } catch {
      // A disposed webview can reject delivery; callers retain only the fixed failure marker.
      return false;
    }
  }
}
