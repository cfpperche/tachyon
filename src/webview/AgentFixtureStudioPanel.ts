import * as vscode from "vscode";
import { renderWebviewShell } from "./shared/shell.js";
import { loadMessage } from "./agent-studio-fixture/messages.js";
import type { AgentFixtureVM } from "./agent-studio-fixture/types.js";

/**
 * spec 350 T5 — Fake 2 (Agent-entity fixture) host wiring: exists ONLY so this surface is a real, openable
 * preact bundle per the webview convention manifest (surfaces.ts / webviewConvention.test.ts) — it is NEVER
 * instantiated or registered from extension.ts (test + preview route only, no command, per the spec). A
 * static single VM, no adapter, no StudioPanelManagerBase — this fixture proves region composition, not
 * lifecycle (Fake 1 / PipelineStudioPanel.ts already proves the lifecycle).
 */
export function openAgentFixtureStudio(extensionUri: vscode.Uri, vm: AgentFixtureVM): vscode.WebviewPanel {
  const root = vscode.Uri.joinPath(extensionUri, "dist", "webview");
  const panel = vscode.window.createWebviewPanel(
    "tachyonAgentFixtureStudio",
    vm.mode === "new" ? "New Agent (shell fixture)" : `Edit Agent — ${vm.entityId ?? ""} (shell fixture)`,
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true },
  );
  const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
  panel.webview.html = renderWebviewShell({
    cspSource: panel.webview.cspSource,
    title: "Agent fixture",
    styles: [uri("codicon.css"), uri("tokens.css"), uri("faces.css"), uri("design-system.css"), uri("quick-picker.css"), uri("studio-frame.css"), uri("agent-studio-fixture.css")],
    bundle: uri("agent-studio-fixture.js"),
    mode: "live",
    // spec 485 A2 — a conforming surface names itself and nothing else: no `extend`, no exception entry.
    surface: "tachyonAgentFixtureStudio",
  });
  panel.webview.onDidReceiveMessage((m: { type?: string }) => {
    if (m?.type === "ready") void panel.webview.postMessage(loadMessage(vm));
    if (m?.type === "cancel" || m?.type === "save") panel.dispose();
  });
  return panel;
}
