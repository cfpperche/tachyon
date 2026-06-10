import * as vscode from "vscode";
import type { AgentManager } from "../agents/AgentManager.js";
import type { TachyonConfig } from "../config/loadConfig.js";
import type { AgentAttention } from "../attention/AttentionMonitor.js";
import type { PinStore } from "../pins/PinStore.js";

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`;
}

export interface AgentItemState {
  running: boolean;
  declared: boolean;
  crashed: boolean;
  exitCode?: number;
}

export class AgentTreeItem extends vscode.TreeItem {
  constructor(
    public readonly agentName: string,
    { running, declared, crashed, exitCode }: AgentItemState,
    attention?: AgentAttention,
    now = Date.now(),
  ) {
    super(agentName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = crashed ? "agent-crashed" : running ? "agent-running" : "agent-stopped";

    if (crashed) {
      this.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
      this.description = exitCode !== undefined ? `crashed — exit ${exitCode}` : "crashed";
      this.tooltip = `${agentName} died${exitCode !== undefined ? ` (exit ${exitCode})` : ""} — the dead pane is kept for postmortem; click to inspect, ↻ to restart, ■ to dismiss`;
      this.command = {
        command: "tachyon.openAgentTerminalItem",
        title: "Inspect",
        arguments: [agentName],
      };
      return;
    }

    if (running && attention?.state === "needs-input") {
      this.iconPath = new vscode.ThemeIcon("bell-dot", new vscode.ThemeColor("charts.yellow"));
      const line = attention.matchedLine ?? "waiting for input";
      this.description = `needs you — ${line.length > 40 ? `${line.slice(0, 40)}…` : line}`;
      this.tooltip = `${agentName} is waiting for your input:\n${line}`;
    } else if (running && attention?.state === "idle") {
      this.iconPath = new vscode.ThemeIcon("circle-outline", new vscode.ThemeColor("charts.yellow"));
      this.description = `idle ${formatDuration(now - attention.since)}`;
      this.tooltip = `${agentName} — no output and no CPU activity`;
    } else if (running) {
      this.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"));
      this.description = "running";
      this.tooltip = `${agentName} — click to open its terminal`;
    } else {
      this.iconPath = new vscode.ThemeIcon("circle-outline");
      this.description = declared ? "stopped" : "ad-hoc (gone on kill)";
      this.tooltip = `${agentName} — use ▶ to start`;
    }

    if (running) {
      this.command = {
        command: "tachyon.openAgentTerminalItem",
        title: "Open Terminal",
        arguments: [agentName],
      };
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

/** "Agents" section: Bridge status first, then every declared/running agent with its attention state. */
export class AgentsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly manager: AgentManager,
    private readonly bridgeUrl: () => string | undefined,
    private readonly attentionOf: (agent: string) => AgentAttention | undefined = () => undefined,
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
    return [
      bridge,
      ...agents.map(
        (a) =>
          new AgentTreeItem(
            a.name,
            { running: a.running, declared: a.declared, crashed: a.crashed, exitCode: a.exitCode },
            this.attentionOf(a.name),
          ),
      ),
    ];
  }
}

export class PinTreeItem extends vscode.TreeItem {
  constructor(
    public readonly pinId: string,
    text: string,
    by: string,
    done: boolean,
  ) {
    super(text, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "pin";
    this.checkboxState = done
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    this.description = `— ${by}`;
    this.tooltip = `${text}\n(${by}, ${pinId})`;
  }
}

/** "Pins" section: notes shortcut first, then the shared checklist. */
export class PinsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: PinStore) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element) return [];
    const notes = new vscode.TreeItem("Notes");
    notes.iconPath = new vscode.ThemeIcon("notebook");
    notes.contextValue = "notes";
    notes.command = { command: "tachyon.openNotes", title: "Open Notes" };
    const firstLine = this.store
      .getNotes()
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    notes.description = firstLine ? (firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine) : "empty";
    notes.tooltip = "Shared whiteboard (.tachyon/notes.md) — click to open";

    let pins;
    try {
      pins = this.store.list();
    } catch (err) {
      const broken = new vscode.TreeItem("pins.json is invalid");
      broken.iconPath = new vscode.ThemeIcon("warning");
      broken.tooltip = err instanceof Error ? err.message : String(err);
      return [notes, broken];
    }
    // open pins first, completed sink to the bottom
    const sorted = [...pins].sort((a, b) => Number(a.done) - Number(b.done) || a.createdAt.localeCompare(b.createdAt));
    return [notes, ...sorted.map((p) => new PinTreeItem(p.id, p.text, p.by, p.done))];
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
