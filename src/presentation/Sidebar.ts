import * as vscode from "vscode";
import type { AgentAttention } from "../attention/AttentionMonitor.js";
import type { RunbookJob } from "../commands/RunbookRunner.js";
import type { Workspace } from "../workspace/Workspace.js";

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`;
}

/**
 * Multi-root (F9): every provider reads a LIST of workspaces. With one folder
 * the trees render exactly as before; with several, each view grows folder
 * roots and every item carries its owning Workspace so command handlers act
 * on the right folder.
 */
type GetWorkspaces = () => Workspace[];

export class FolderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly ws: Workspace,
    view: string,
  ) {
    super(ws.folderName, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "folder";
    this.iconPath = new vscode.ThemeIcon("folder");
    this.id = `tachyon-folder-${view}-${ws.wsHash}`;
    this.tooltip = ws.workspaceRoot;
  }
}

export interface AgentItemState {
  running: boolean;
  declared: boolean;
  dead: boolean;
  crashed: boolean;
  exitCode?: number;
  kind: "agent" | "terminal";
}

export class AgentTreeItem extends vscode.TreeItem {
  constructor(
    public readonly ws: Workspace,
    public readonly agentName: string,
    { running, declared, dead, crashed, exitCode, kind }: AgentItemState,
    attention?: AgentAttention,
    now = Date.now(),
    hasChildren = false,
    parent?: string,
  ) {
    super(agentName, hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    if (parent) this.description = vscode.l10n.t("spawned by {0}", parent);
    this.contextValue = dead ? "agent-crashed" : running ? "agent-running" : "agent-stopped";
    const kindIcon = kind === "agent" ? "hubot" : "terminal";

    if (dead && !crashed) {
      // Clean exit (0): informational, not alarming — postmortem still available.
      this.iconPath = new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"));
      this.description = vscode.l10n.t("exited (0)");
      this.tooltip = vscode.l10n.t("{0} exited cleanly — click to inspect, ↻ to restart, ■ to dismiss", agentName);
      this.command = { command: "tachyon.openAgentTerminalItem", title: "Inspect", arguments: [agentName, ws.wsHash] };
      return;
    }

    if (crashed) {
      this.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
      this.description = exitCode !== undefined ? vscode.l10n.t("crashed — exit {0}", exitCode) : vscode.l10n.t("crashed");
      this.tooltip = vscode.l10n.t("{0} died{1} — the dead pane is kept for postmortem; click to inspect, ↻ to restart, ■ to dismiss", agentName, exitCode !== undefined ? ` (exit ${exitCode})` : "");
      this.command = {
        command: "tachyon.openAgentTerminalItem",
        title: "Inspect",
        arguments: [agentName, ws.wsHash],
      };
      return;
    }

    if (running && attention?.state === "needs-input") {
      this.iconPath = new vscode.ThemeIcon("bell-dot", new vscode.ThemeColor("charts.yellow"));
      const line = attention.matchedLine ?? "waiting for input";
      this.description = vscode.l10n.t("needs you — {0}", line.length > 40 ? `${line.slice(0, 40)}…` : line);
      this.tooltip = vscode.l10n.t("{0} is waiting for your input:", agentName) + `\n${line}`;
    } else if (running && attention?.state === "idle") {
      this.iconPath = new vscode.ThemeIcon("circle-outline", new vscode.ThemeColor("charts.yellow"));
      this.description = vscode.l10n.t("idle {0}", formatDuration(now - attention.since));
      this.tooltip = vscode.l10n.t("{0} — no output and no CPU activity", agentName);
    } else if (running) {
      this.iconPath = new vscode.ThemeIcon(kindIcon, new vscode.ThemeColor("charts.green"));
      this.description = vscode.l10n.t("running");
      this.tooltip = vscode.l10n.t("{0} — click to open its terminal", agentName);
    } else {
      this.iconPath = new vscode.ThemeIcon(kindIcon, new vscode.ThemeColor("disabledForeground"));
      this.description = declared ? vscode.l10n.t("stopped") : vscode.l10n.t("ad-hoc (gone on kill)");
      this.tooltip = vscode.l10n.t("{0} — use ▶ to start", agentName);
    }

    if (running) {
      this.command = {
        command: "tachyon.openAgentTerminalItem",
        title: "Open Terminal",
        arguments: [agentName, ws.wsHash],
      };
    }
  }
}

export class LayoutTreeItem extends vscode.TreeItem {
  constructor(
    public readonly ws: Workspace,
    public readonly layoutName: string,
    grid: string,
    agents: string[],
  ) {
    super(layoutName, vscode.TreeItemCollapsibleState.None);
    this.description = `${grid} — ${agents.join(", ")}`;
    this.contextValue = "layout";
    this.iconPath = new vscode.ThemeIcon("editor-layout");
    this.command = { command: "tachyon.applyLayout", title: "Apply Layout", arguments: [layoutName, ws.wsHash] };
    this.tooltip = vscode.l10n.t("click to apply '{0}'", layoutName);
  }
}

class GroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly ws: Workspace,
    label: string,
    ctx: string,
    icon: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = ctx;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.id = `tachyon-${ctx}-${ws.wsHash}`;
  }
}

/** "Agents" section: Bridge status first, then every declared/running agent with its attention state. */
export class AgentsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly getWorkspaces: GetWorkspaces) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      const all = this.getWorkspaces();
      if (all.length === 0) return [];
      if (all.length === 1) return this.rootsOf(all[0]);
      return all.map((ws) => new FolderTreeItem(ws, "agents"));
    }
    if (element instanceof FolderTreeItem) return this.rootsOf(element.ws);

    const ws = (element as GroupTreeItem | AgentTreeItem).ws;
    if (!ws) return [];
    const all = await ws.manager.list();
    const present = new Set(all.map((a) => a.name));
    const childrenOf = (name: string) => all.filter((a) => a.parent === name);
    const toItem = (a: (typeof all)[number]) =>
      new AgentTreeItem(
        ws,
        a.name,
        { running: a.running, declared: a.declared, dead: a.dead, crashed: a.crashed, exitCode: a.exitCode, kind: a.kind },
        ws.attentionOf(a.name),
        Date.now(),
        childrenOf(a.name).length > 0,
        a.parent && present.has(a.parent) ? a.parent : undefined,
      );

    if (element instanceof AgentTreeItem) {
      // lineage: children nest under their parent regardless of kind
      return childrenOf(element.agentName).map(toItem);
    }
    const kind = element.contextValue === "group-terminals" ? "terminal" : "agent";
    // roots: no parent, or parent gone (orphans promoted)
    return all.filter((a) => a.kind === kind && (!a.parent || !present.has(a.parent))).map(toItem);
  }

  private async rootsOf(ws: Workspace): Promise<vscode.TreeItem[]> {
    const all = await ws.manager.list();

    const bridge = new vscode.TreeItem("Bridge");
    const url = ws.bridgeUrl();
    bridge.description = url ?? vscode.l10n.t("not running");
    bridge.iconPath = new vscode.ThemeIcon("zap", url ? new vscode.ThemeColor("charts.yellow") : undefined);
    bridge.contextValue = "bridge";
    bridge.tooltip = url ? vscode.l10n.t("MCP endpoint — click to copy") : vscode.l10n.t("Bridge is not running");
    bridge.id = `tachyon-bridge-${ws.wsHash}`;
    if (url) {
      bridge.command = { command: "tachyon.copyBridgeUrl", title: "Copy Bridge URL", arguments: [ws.wsHash] };
    }

    const agents = all.filter((a) => a.kind === "agent");
    const terminals = all.filter((a) => a.kind === "terminal");
    const group = (label: string, ctx: string, members: typeof all, icon: string) => {
      const node = new GroupTreeItem(ws, label, ctx, icon);
      node.description = `${members.filter((m) => m.running).length}/${members.length}`;
      return node;
    };
    const out: vscode.TreeItem[] = [bridge];
    if (agents.length > 0) out.push(group(vscode.l10n.t("Agents"), "group-agents", agents, "hubot"));
    if (terminals.length > 0) out.push(group(vscode.l10n.t("Terminals"), "group-terminals", terminals, "terminal"));
    return out;
  }
}

export class PinTreeItem extends vscode.TreeItem {
  constructor(
    public readonly ws: Workspace,
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

export class CommandTreeItem extends vscode.TreeItem {
  constructor(
    public readonly ws: Workspace,
    public readonly commandName: string,
    state: "running" | "passed" | "failed" | "idle",
    exitCode?: number,
    durationMs?: number,
  ) {
    super(commandName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = state === "running" ? "command-running" : "command";
    if (state === "running") {
      this.iconPath = new vscode.ThemeIcon("play-circle", new vscode.ThemeColor("charts.yellow"));
      this.description = vscode.l10n.t("running");
    } else if (state === "passed") {
      this.iconPath = new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"));
      this.description = durationMs !== undefined ? vscode.l10n.t("exit 0 · {0}s", Math.round(durationMs / 1000)) : vscode.l10n.t("exit 0");
    } else if (state === "failed") {
      this.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
      this.description = vscode.l10n.t("exit {0}", exitCode ?? "?");
    } else {
      this.iconPath = new vscode.ThemeIcon("circle-outline");
      this.description = vscode.l10n.t("never run");
    }
    if (state !== "idle") {
      this.command = { command: "tachyon.openCommandTerminalItem", title: "Open", arguments: [commandName, ws.wsHash] };
      this.tooltip = vscode.l10n.t("{0} — click to inspect the run's output", commandName);
    } else {
      this.tooltip = vscode.l10n.t("{0} — ▶ runs it", commandName);
    }
  }
}

export class RunbookTreeItem extends vscode.TreeItem {
  constructor(
    public readonly ws: Workspace,
    public readonly runbookName: string,
    running: boolean,
    lastJob?: RunbookJob,
  ) {
    super(runbookName, lastJob ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.contextValue = running ? "runbook-running" : "runbook";
    if (running) {
      this.iconPath = new vscode.ThemeIcon("play-circle", new vscode.ThemeColor("charts.yellow"));
      this.description = vscode.l10n.t("running");
    } else if (lastJob?.outcome === "passed") {
      this.iconPath = new vscode.ThemeIcon("checklist", new vscode.ThemeColor("charts.green"));
      this.description = vscode.l10n.t("passed · {0} steps", lastJob.steps.length);
    } else if (lastJob?.outcome === "failed") {
      this.iconPath = new vscode.ThemeIcon("checklist", new vscode.ThemeColor("charts.red"));
      const failed = lastJob.steps.find((st) => st.state === "failed");
      this.description = vscode.l10n.t("failed at step {0}", (failed?.index ?? 0) + 1);
    } else {
      this.iconPath = new vscode.ThemeIcon("checklist");
      this.description = vscode.l10n.t("never run");
    }
  }
}

class StepTreeItem extends vscode.TreeItem {
  constructor(ws: Workspace, runbook: string, step: { index: number; step: string; state: string; exitCode?: number; durationMs?: number }) {
    super(`${step.index + 1}. ${step.step}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "runbook-step";
    if (step.state === "passed") {
      this.iconPath = new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"));
      this.description = step.durationMs !== undefined ? `${Math.round(step.durationMs / 1000)}s` : "";
    } else if (step.state === "failed") {
      this.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
      this.description = vscode.l10n.t("exit {0}", step.exitCode ?? "?");
      this.command = { command: "tachyon.openRunbookStepItem", title: "Inspect", arguments: [runbook, step.index, ws.wsHash] };
    } else if (step.state === "running") {
      this.iconPath = new vscode.ThemeIcon("play-circle", new vscode.ThemeColor("charts.yellow"));
    } else {
      this.iconPath = new vscode.ThemeIcon("circle-outline");
      this.description = vscode.l10n.t("skipped");
    }
  }
}

/** "Commands" view: one-shot commands + runbooks (steps of the last job nested). */
export class CommandsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly getWorkspaces: GetWorkspaces) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      const all = this.getWorkspaces();
      if (all.length === 0) return [];
      if (all.length === 1) return this.rootsOf(all[0]);
      return all.map((ws) => new FolderTreeItem(ws, "commands"));
    }
    if (element instanceof FolderTreeItem) return this.rootsOf(element.ws);

    if (element instanceof RunbookTreeItem) {
      const job = element.ws.runbookRunner.currentJob(element.runbookName);
      return (job?.steps ?? []).map((st) => new StepTreeItem(element.ws, element.runbookName, st));
    }
    const ws = (element as GroupTreeItem).ws;
    if (!ws) return [];
    if (element.contextValue === "group-commands") {
      const list = await ws.commandRunner.list();
      return list.map((c) => new CommandTreeItem(ws, c.name, c.state, c.exitCode, c.lastRun?.finishedAt !== undefined && c.lastRun.startedAt !== undefined ? c.lastRun.finishedAt - c.lastRun.startedAt : undefined));
    }
    if (element.contextValue === "group-runbooks") {
      return ws.runbookRunner.list().map((r) => new RunbookTreeItem(ws, r.name, r.running, r.lastJob));
    }
    return [];
  }

  private async rootsOf(ws: Workspace): Promise<vscode.TreeItem[]> {
    const out: vscode.TreeItem[] = [];
    const commands = await ws.commandRunner.list();
    const runbooks = ws.runbookRunner.list();
    if (commands.length > 0) out.push(new GroupTreeItem(ws, vscode.l10n.t("Commands"), "group-commands", "terminal-cmd"));
    if (runbooks.length > 0) out.push(new GroupTreeItem(ws, vscode.l10n.t("Runbooks"), "group-runbooks", "checklist"));
    if (out.length === 0) {
      const hint = new vscode.TreeItem(vscode.l10n.t("No commands in tachyon.yml"));
      hint.iconPath = new vscode.ThemeIcon("info");
      out.push(hint);
    }
    return out;
  }
}

/** "Pins" section: notes shortcut first, then the shared checklist. */
export class PinsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly getWorkspaces: GetWorkspaces) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (!element) {
      const all = this.getWorkspaces();
      if (all.length === 0) return [];
      if (all.length === 1) return this.rootsOf(all[0]);
      return all.map((ws) => new FolderTreeItem(ws, "pins"));
    }
    if (element instanceof FolderTreeItem) return this.rootsOf(element.ws);
    return [];
  }

  private rootsOf(ws: Workspace): vscode.TreeItem[] {
    const notes = new vscode.TreeItem(vscode.l10n.t("Notes"));
    notes.iconPath = new vscode.ThemeIcon("notebook");
    notes.contextValue = "notes";
    notes.id = `tachyon-notes-${ws.wsHash}`;
    notes.command = { command: "tachyon.openNotes", title: "Open Notes", arguments: [ws.wsHash] };
    const firstLine = ws.pinStore
      .getNotes()
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    notes.description = firstLine ? (firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine) : vscode.l10n.t("empty");
    notes.tooltip = vscode.l10n.t("Shared whiteboard (.tachyon/notes.md) — click to open");

    let pins;
    try {
      pins = ws.pinStore.list();
    } catch (err) {
      const broken = new vscode.TreeItem(vscode.l10n.t("pins.json is invalid"));
      broken.iconPath = new vscode.ThemeIcon("warning");
      broken.tooltip = err instanceof Error ? err.message : String(err);
      return [notes, broken];
    }
    // open pins first, completed sink to the bottom
    const sorted = [...pins].sort((a, b) => Number(a.done) - Number(b.done) || a.createdAt.localeCompare(b.createdAt));
    return [notes, ...sorted.map((p) => new PinTreeItem(ws, p.id, p.text, p.by, p.done))];
  }
}

/** "Layouts" section: named grids from tachyon.yml; click applies. */
export class LayoutsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly getWorkspaces: GetWorkspaces) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (!element) {
      const all = this.getWorkspaces();
      if (all.length === 0) return [];
      if (all.length === 1) return this.rootsOf(all[0]);
      return all.map((ws) => new FolderTreeItem(ws, "layouts"));
    }
    if (element instanceof FolderTreeItem) return this.rootsOf(element.ws);
    return [];
  }

  private rootsOf(ws: Workspace): vscode.TreeItem[] {
    const layouts = Object.entries(ws.config?.layouts ?? {});
    if (layouts.length === 0) {
      const hint = new vscode.TreeItem(vscode.l10n.t("No layouts in tachyon.yml"));
      hint.iconPath = new vscode.ThemeIcon("info");
      return [hint];
    }
    return layouts.map(([name, def]) => new LayoutTreeItem(ws, name, def.grid ?? "custom", def.agents));
  }
}
