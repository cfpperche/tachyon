import * as vscode from "vscode";
import type { AgentManager } from "../agents/AgentManager.js";
import type { TachyonConfig } from "../config/loadConfig.js";

export class AgentTreeItem extends vscode.TreeItem {
  constructor(
    public readonly agentName: string,
    running: boolean,
    declared: boolean,
  ) {
    super(agentName, vscode.TreeItemCollapsibleState.None);
    this.description = running ? "running" : declared ? "stopped" : "ad-hoc (gone on kill)";
    this.contextValue = running ? "agent-running" : "agent-stopped";
    this.iconPath = running
      ? new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"))
      : new vscode.ThemeIcon("circle-outline");
    if (running) {
      this.command = {
        command: "tachyon.openAgentTerminalItem",
        title: "Open Terminal",
        arguments: [agentName],
      };
      this.tooltip = `${agentName} — click to open its terminal`;
    } else {
      this.tooltip = `${agentName} — use ▶ to start`;
    }
  }
}

export class LayoutTreeItem extends vscode.TreeItem {
  constructor(
    public readonly layoutName: string,
    grid: string,
    agents: string[],
  ) {
    super(layoutName, vscode.TreeItemCollapsibleState.None);
    this.description = `${grid} — ${agents.join(", ")}`;
    this.contextValue = "layout";
    this.iconPath = new vscode.ThemeIcon("editor-layout");
    this.command = { command: "tachyon.applyLayout", title: "Apply Layout", arguments: [layoutName] };
    this.tooltip = `click to apply '${layoutName}'`;
  }
}

/** "Agents" section: Bridge status first, then every declared/running agent. */
export class AgentsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly manager: AgentManager,
    private readonly bridgeUrl: () => string | undefined,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) return [];
    const bridge = new vscode.TreeItem("Bridge");
    const url = this.bridgeUrl();
    bridge.description = url ?? "not running";
    bridge.iconPath = new vscode.ThemeIcon("zap", url ? new vscode.ThemeColor("charts.yellow") : undefined);
    bridge.contextValue = "bridge";
    bridge.tooltip = url ? "MCP endpoint — click to copy" : "Bridge is not running";
    if (url) {
      bridge.command = { command: "tachyon.copyBridgeUrl", title: "Copy Bridge URL" };
    }
    const agents = await this.manager.list();
    return [bridge, ...agents.map((a) => new AgentTreeItem(a.name, a.running, a.declared))];
  }
}

/** "Layouts" section: named grids from tachyon.yml; click applies. */
export class LayoutsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly getConfig: () => TachyonConfig | undefined) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element) return [];
    const layouts = Object.entries(this.getConfig()?.layouts ?? {});
    if (layouts.length === 0) {
      const hint = new vscode.TreeItem("No layouts in tachyon.yml");
      hint.iconPath = new vscode.ThemeIcon("info");
      return [hint];
    }
    return layouts.map(([name, def]) => new LayoutTreeItem(name, def.grid, def.agents));
  }
}
