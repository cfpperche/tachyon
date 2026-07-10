import * as vscode from "vscode";
import { emptyRuntimeOpsSnapshot, type RuntimeOpsSnapshotV1 } from "../runtimeOps/types.js";
import { renderWebviewShell } from "./shared/shell.js";
import { READY } from "./shared/ready.js";
import { runtimeOpsSnapshotMessage } from "./runtime-ops/messages.js";

export type RuntimeOpsSnapshotBuilder = () => RuntimeOpsSnapshotV1 | Promise<RuntimeOpsSnapshotV1>;

export class RuntimeOpsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "tachyonRuntimeOpsView";
  private view?: vscode.WebviewView;
  private renderToken = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly buildSnapshot: RuntimeOpsSnapshotBuilder = emptyRuntimeOpsSnapshot,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const uri = (file: string): string => view.webview.asWebviewUri(vscode.Uri.joinPath(root, file)).toString();
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    view.webview.html = renderWebviewShell({
      cspSource: view.webview.cspSource,
      title: "Runtime Ops",
      styles: [uri("design-system.css"), uri("runtime-ops.css")],
      bundle: uri("runtime-ops.js"),
      mode: "live",
      scriptCspSource: false,
    });

    const ready = view.webview.onDidReceiveMessage((message: { type?: string } | undefined) => {
      if (message?.type === READY) void this.push(view);
    });
    const visibility = view.onDidChangeVisibility(() => {
      if (view.visible) void this.push(view);
    });
    view.onDidDispose(() => {
      ready.dispose();
      visibility.dispose();
      if (this.view === view) this.view = undefined;
      this.renderToken += 1;
    });
  }

  refresh(): void {
    const view = this.view;
    if (view?.visible) void this.push(view);
  }

  private async push(view: vscode.WebviewView): Promise<void> {
    if (this.view !== view || !view.visible) return;
    const token = ++this.renderToken;
    const snapshot = await this.buildSnapshot();
    if (this.view !== view || !view.visible || token !== this.renderToken) return;
    await view.webview.postMessage(runtimeOpsSnapshotMessage(snapshot));
  }
}
