import * as vscode from "vscode";
import type { AgentManager } from "../agents/AgentManager.js";
import type { TachyonConfig } from "../config/loadConfig.js";
import type { AgentAttention } from "../attention/AttentionMonitor.js";
import type { PinStore } from "../pins/PinStore.js";
import type { CommandRunner } from "../commands/CommandRunner.js";
import type { RunbookRunner, RunbookJob } from "../commands/RunbookRunner.js";

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`;
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
      this.command = { command: "tachyon.openAgentTerminalItem", title: "Inspect", arguments: [agentName] };
      return;
    }

    if (crashed) {
      this.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
      this.description = exitCode !== undefined ? vscode.l10n.t("crashed — exit {0}", exitCode) : vscode.l10n.t("crashed");
      this.tooltip = vscode.l10n.t("{0} died{1} — the dead pane is kept for postmortem; click to inspect, ↻ to restart, ■ to dismiss", agentName, exitCode !== undefined ? ` (exit ${exitCode})` : "");
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
    this.tooltip = vscode.l10n.t("click to apply '{0}'", layoutName);
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
    const all = await this.manager.list();
    const present = new Set(all.map((a) => a.name));
    const childrenOf = (name: string) => all.filter((a) => a.parent === name);
    const toItem = (a: (typeof all)[number]) =>
      new AgentTreeItem(
        a.name,
        { running: a.running, declared: a.declared, dead: a.dead, crashed: a.crashed, exitCode: a.exitCode, kind: a.kind },
        this.attentionOf(a.name),
        Date.now(),
        childrenOf(a.name).length > 0,
        a.parent && present.has(a.parent) ? a.parent : undefined,
      );

    if (element instanceof AgentTreeItem) {
      // lineage: children nest under their parent regardless of kind
      return childrenOf(element.agentName).map(toItem);
    }
    if (element) {
      const kind = element.contextValue === "group-terminals" ? "terminal" : "agent";
      // roots: no parent, or parent gone (orphans promoted)
      return all.filter((a) => a.kind === kind && (!a.parent || !present.has(a.parent))).map(toItem);
    }

    const bridge = new vscode.TreeItem("Bridge");
    const url = this.bridgeUrl();
    bridge.description = url ?? vscode.l10n.t("not running");
    bridge.iconPath = new vscode.ThemeIcon("zap", url ? new vscode.ThemeColor("charts.yellow") : undefined);
    bridge.contextValue = "bridge";
    bridge.tooltip = url ? vscode.l10n.t("MCP endpoint — click to copy") : vscode.l10n.t("Bridge is not running");
    if (url) {
      bridge.command = { command: "tachyon.copyBridgeUrl", title: "Copy Bridge URL" };
    }

    const agents = all.filter((a) => a.kind === "agent");
    const terminals = all.filter((a) => a.kind === "terminal");
    const group = (label: string, ctx: string, members: typeof all, icon: string) => {
      const node = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
      node.contextValue = ctx;
      node.description = `${members.filter((m) => m.running).length}/${members.length}`;
      node.iconPath = new vscode.ThemeIcon(icon);
      node.id = `tachyon-group-${ctx}`;
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
      this.command = { command: "tachyon.openCommandTerminalItem", title: "Open", arguments: [commandName] };
      this.tooltip = vscode.l10n.t("{0} — click to inspect the run's output", commandName);
    } else {
      this.tooltip = vscode.l10n.t("{0} — ▶ runs it", commandName);
    }
  }
}

export class RunbookTreeItem extends vscode.TreeItem {
  constructor(
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
  constructor(runbook: string, step: { index: number; step: string; state: string; exitCode?: number; durationMs?: number }) {
    super(`${step.index + 1}. ${step.step}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "runbook-step";
    if (step.state === "passed") {
      this.iconPath = new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"));
      this.description = step.durationMs !== undefined ? `${Math.round(step.durationMs / 1000)}s` : "";
    } else if (step.state === "failed") {
      this.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
      this.description = vscode.l10n.t("exit {0}", step.exitCode ?? "?");
      this.command = { command: "tachyon.openRunbookStepItem", title: "Inspect", arguments: [runbook, step.index] };
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

  constructor(
    private readonly commands: CommandRunner,
    private readonly runbooks: RunbookRunner,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element instanceof RunbookTreeItem) {
      const job = this.runbooks.currentJob(element.runbookName);
      return (job?.steps ?? []).map((st) => new StepTreeItem(element.runbookName, st));
    }
    if (element?.contextValue === "group-commands") {
      const list = await this.commands.list();
      return list.map((c) => new CommandTreeItem(c.name, c.state, c.exitCode, c.lastRun?.finishedAt !== undefined && c.lastRun.startedAt !== undefined ? c.lastRun.finishedAt - c.lastRun.startedAt : undefined));
    }
    if (element?.contextValue === "group-runbooks") {
      return this.runbooks.list().map((r) => new RunbookTreeItem(r.name, r.running, r.lastJob));
    }
    if (element) return [];

    const out: vscode.TreeItem[] = [];
    const commands = await this.commands.list();
    const runbooks = this.runbooks.list();
    if (commands.length > 0) {
      const g = new vscode.TreeItem(vscode.l10n.t("Commands"), vscode.TreeItemCollapsibleState.Expanded);
      g.contextValue = "group-commands";
      g.iconPath = new vscode.ThemeIcon("terminal-cmd");
      g.id = "tachyon-group-commands";
      out.push(g);
    }
    if (runbooks.length > 0) {
      const g = new vscode.TreeItem(vscode.l10n.t("Runbooks"), vscode.TreeItemCollapsibleState.Expanded);
      g.contextValue = "group-runbooks";
      g.iconPath = new vscode.ThemeIcon("checklist");
      g.id = "tachyon-group-runbooks";
      out.push(g);
    }
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

  constructor(private readonly store: PinStore) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element) return [];
    const notes = new vscode.TreeItem(vscode.l10n.t("Notes"));
    notes.iconPath = new vscode.ThemeIcon("notebook");
    notes.contextValue = "notes";
    notes.command = { command: "tachyon.openNotes", title: "Open Notes" };
    const firstLine = this.store
      .getNotes()
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    notes.description = firstLine ? (firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine) : vscode.l10n.t("empty");
    notes.tooltip = vscode.l10n.t("Shared whiteboard (.tachyon/notes.md) — click to open");

    let pins;
    try {
      pins = this.store.list();
    } catch (err) {
      const broken = new vscode.TreeItem(vscode.l10n.t("pins.json is invalid"));
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
      const hint = new vscode.TreeItem(vscode.l10n.t("No layouts in tachyon.yml"));
      hint.iconPath = new vscode.ThemeIcon("info");
      return [hint];
    }
    return layouts.map(([name, def]) => new LayoutTreeItem(name, def.grid ?? "custom", def.agents));
  }
}
