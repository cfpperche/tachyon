import * as vscode from "vscode";
import type { AgentAttention } from "../attention/AttentionMonitor.js";
import type { RunbookJob } from "../commands/RunbookRunner.js";
import type { Workspace } from "../workspace/Workspace.js";
import { isResumable } from "../resume/SessionLedger.js";
import { adapterFor, forkable, managesOwnSession } from "../resume/adapters.js";
import { agentContextValue } from "./contextValue.js";
import { runStatus, type PipelineRun, type NodeStatus } from "../pipeline/runState.js";
import { nodeContextValue, runIcon, nodeIcon } from "../pipeline/pipelinePresentation.js";
import { nodeSpawnName } from "../pipeline/loadPipeline.js";
import type { VerifyBadge } from "../worktree/verify.js";

/** spec 214 — verify-gate badge render info for a worktree agent (undefined → no badge). */
export interface VerifyRender {
  badge: VerifyBadge;
  command: string;
  /** ISO timestamp of the last run (absent → never run). */
  ranAt?: string;
}

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
    /** Has a saved session in the ledger (spec 209): a stopped/crashed agent can resume WITH its prior conversation. */
    resumable = false,
    /** spec 210 — the isolated git branch when this agent runs in its own worktree (shows a ⎇ badge + enables the Remove worktree action). */
    worktreeBranch?: string,
    /** spec 214 — the verify-gate badge (✓/✗/⊘) when this worktree agent declares a `verify:`. */
    verify?: VerifyRender,
    /** spec 221 — for a resumable agent, whether the transcript is on disk (↻ restores context) vs
     *  gone/uncaptured (↻ degrades to fresh). `undefined` = unprobed → render as before (resumable). */
    resumeReady?: boolean,
    /** spec 225 — running agent whose runtime can fork its session natively (claude) → enables the "Fork session" action. */
    canFork = false,
    /** spec 226 — declares an isolated harness (its own MCP config home) → shows a ⚙ badge + tooltip. */
    hasHarness = false,
  ) {
    super(agentName, hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    const wtBadge = worktreeBranch ? ` ⎇ ${worktreeBranch}` : "";
    // Stable identity for expansion persistence — must flip when the agent gains
    // its first child so VS Code re-renders it as a fresh Expanded node. An
    // agent that autostarts renders as a leaf first; without the ":p" suffix on
    // the id, VS Code remembers the leaf's collapsed state and never opens the
    // node when a spawned child later appears. State (running/dead/attention)
    // is deliberately NOT in the id, so a manual collapse survives a refresh.
    this.id = `tachyon-agent-${ws.wsHash}-${agentName}${hasChildren ? ":p" : ""}`;
    if (parent) this.description = vscode.l10n.t("spawned by {0}", parent);
    // `-adhoc` suffix marks MCP-spawned agents (not in tachyon.yml) so the
    // "Save to tachyon.yml" (promote) action can target only them. State menus
    // match by prefix (`/^agent-running/` etc.) so they still apply to ad-hoc.
    // contextValue is built by the shared, unit-tested agentContextValue() (the single source of truth
    // for the segment contract; matchers must use segment-aware tests, never endsWith/`$`). `-ai` (216)
    // gates AI-only actions, `-adhoc` marks MCP/forked agents, `-verifiable` the Verify gate (214),
    // `-forkable` the "Fork session" action (225, running fork-capable runtime; fail-closed at click).
    this.contextValue = agentContextValue({
      state: dead ? "crashed" : running ? "running" : "stopped",
      ai: kind === "agent",
      adhoc: !declared,
      worktree: !!worktreeBranch,
      verifiable: !!verify,
      forkable: canFork,
      harness: hasHarness,
    });

    // spec 214 — verify-gate badge (✓/✗/⊘), applied in EVERY state. Defined as a closure so the
    // dead/clean-exit/crashed early-returns below still show it — that's exactly when a parent
    // checks "child done AND verified" before merging (round-2 review fix: it was being dropped).
    const applyVerifyBadge = (): void => {
      if (!verify) return;
      const glyph = verify.badge === "verified" ? "✓" : verify.badge === "failing" ? "✗" : "⊘";
      this.description = `${this.description ?? ""} · ${glyph}`;
      const ran = verify.ranAt ? ` (${formatDuration(now - Date.parse(verify.ranAt))} ago)` : "";
      const detail =
        verify.badge === "verified"
          ? vscode.l10n.t("verified: '{0}' passed{1}", verify.command, ran)
          : verify.badge === "failing"
            ? vscode.l10n.t("verify failed: '{0}'{1}", verify.command, ran)
            : verify.ranAt
              ? vscode.l10n.t("not verified — '{0}' is stale (work changed since); re-run Verify", verify.command)
              : vscode.l10n.t("not verified — run Verify ('{0}')", verify.command);
      this.tooltip = `${typeof this.tooltip === "string" ? this.tooltip : ""}\n${detail}`.trim();
    };
    const kindIcon = kind === "agent" ? "hubot" : "terminal";

    if (dead && !crashed) {
      // Clean exit (0): informational, not alarming — postmortem still available.
      this.iconPath = new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"));
      this.description = vscode.l10n.t("exited (0)") + wtBadge;
      this.tooltip = vscode.l10n.t("{0} exited cleanly — click to inspect, ↻ to restart, ■ to dismiss", agentName);
      this.command = { command: "tachyon.openAgentTerminalItem", title: "Inspect", arguments: [agentName, ws.wsHash] };
      applyVerifyBadge();
      return;
    }

    // spec 221 — honest resume affordance: a saved session whose transcript is on disk resumes WITH
    // context; one that's gone/uncaptured (resumeReady === false) would degrade to a fresh start.
    const freshOnly = resumable && resumeReady === false;
    const resumeTag = freshOnly ? vscode.l10n.t("fresh start") : vscode.l10n.t("resumable");
    const resumeHint = freshOnly
      ? vscode.l10n.t("↻ no saved context on disk — Resume will start fresh.")
      : vscode.l10n.t("↻ Resume with context replays its saved conversation; ↻ restart starts fresh.");

    if (crashed) {
      this.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
      const base = exitCode !== undefined ? vscode.l10n.t("crashed — exit {0}", exitCode) : vscode.l10n.t("crashed");
      this.description = (resumable ? `${base} · ${resumeTag}` : base) + wtBadge;
      this.tooltip = vscode.l10n.t("{0} died{1} — the dead pane is kept for postmortem; click to inspect, ↻ to restart, ■ to dismiss", agentName, exitCode !== undefined ? ` (exit ${exitCode})` : "")
        + (resumable ? `\n${resumeHint}` : "");
      this.command = {
        command: "tachyon.openAgentTerminalItem",
        title: "Inspect",
        arguments: [agentName, ws.wsHash],
      };
      applyVerifyBadge();
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
      const base = declared ? vscode.l10n.t("stopped") : vscode.l10n.t("ad-hoc");
      this.description = resumable ? `${base} · ${resumeTag}` : base;
      this.tooltip = resumable
        ? (freshOnly
            ? vscode.l10n.t("{0} — saved session has no transcript on disk; ↻/▶ both start fresh.", agentName)
            : vscode.l10n.t("{0} — has a saved session. ↻ Resume with context, or ▶ start fresh.", agentName))
        : vscode.l10n.t("{0} — use ▶ to start", agentName);
    }

    // spec 210 — surface the isolated branch on every state (running/idle/needs/stopped).
    if (worktreeBranch) {
      this.description = `${this.description ?? ""}${wtBadge}`;
      this.tooltip = `${typeof this.tooltip === "string" ? this.tooltip : ""}\n${vscode.l10n.t("worktree branch: {0}", worktreeBranch)}`.trim();
    }

    // spec 226 — surface the isolated harness (its own MCP config home) on every state.
    if (hasHarness) {
      this.description = `${this.description ?? ""} ⚙`;
      this.tooltip = `${typeof this.tooltip === "string" ? this.tooltip : ""}\n${vscode.l10n.t("isolated harness — runs with its own MCP config (not shared with other agents)")}`.trim();
    }

    // spec 214 — verify-gate badge (✓ verified / ✗ failing / ⊘ not verified), keyed to the commit.
    applyVerifyBadge();

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

/** spec 230 — a DEFINED pipeline (.tachyon/pipelines/<name>.yml), always shown. Carries its active run
 *  (running/paused) if any, and expands to that run's nodes. ▶ Run / ⏹ Cancel / ✎ Edit / 🗑 Delete. */
export class PipelineDefTreeItem extends vscode.TreeItem {
  constructor(
    readonly ws: Workspace,
    readonly pipelineName: string,
    readonly run?: PipelineRun,
  ) {
    const active = run ? runStatus(run) : undefined; // "running" | "paused" (only active runs are passed)
    super(pipelineName, run ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.id = `tachyon-pldef-${ws.wsHash}-${pipelineName}`;
    this.description = active && run ? `${run.id} · ${active}` : "idle";
    this.contextValue = `pipeline-def-${active ?? "idle"}`;
    this.iconPath = new vscode.ThemeIcon(active ? runIcon(active) : "run-all");
  }
}

/** spec 230 — one node of a pipeline run; contextValue gates Approve/Reject (awaiting-approval only). */
export class PipelineNodeTreeItem extends vscode.TreeItem {
  constructor(
    readonly ws: Workspace,
    readonly runId: string,
    readonly nodeId: string,
    status: NodeStatus,
    reason: string | undefined,
    spawnName: string,
  ) {
    super(nodeId, vscode.TreeItemCollapsibleState.None);
    this.id = `tachyon-plnode-${ws.wsHash}-${runId}-${nodeId}`;
    this.description = reason ? `${status} — ${reason}` : status;
    this.contextValue = nodeContextValue(status);
    this.iconPath = new vscode.ThemeIcon(nodeIcon(status));
    // Click to open the node agent's terminal — see what it produced (e.g. the review at a gate).
    // Best-effort: a dismissed (done/failed) `cmd:` node has no live terminal; an awaiting-approval
    // node does, and a declared `agent:` node opens that specialist agent's terminal.
    this.command = { command: "tachyon.openAgentTerminalItem", title: "Inspect", arguments: [spawnName, ws.wsHash] };
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

/** Bridge (MCP endpoint) status line — top of the tree, outside any category. */
function bridgeItem(ws: Workspace): vscode.TreeItem {
  const bridge = new vscode.TreeItem("Bridge");
  const url = ws.bridgeUrl();
  bridge.description = url ?? vscode.l10n.t("not running");
  bridge.iconPath = new vscode.ThemeIcon("zap", url ? new vscode.ThemeColor("charts.yellow") : undefined);
  bridge.contextValue = "bridge";
  bridge.tooltip = url ? vscode.l10n.t("MCP endpoint — click to copy") : vscode.l10n.t("Bridge is not running");
  bridge.id = `tachyon-bridge-${ws.wsHash}`;
  if (url) bridge.command = { command: "tachyon.copyBridgeUrl", title: "Copy Bridge URL", arguments: [ws.wsHash] };
  return bridge;
}

/** A muted "(empty)" leaf so an always-visible category reads as present-but-empty. */
function emptyHint(label: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label);
  item.iconPath = new vscode.ThemeIcon("blank");
  item.contextValue = "empty";
  return item;
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
    // Agents with a saved session in the ledger (spec 209) — a stopped/crashed one
    // can be resumed WITH its prior conversation, surfaced as a "resumable" badge.
    const resumableNames = new Set([...ws.ledger.all()].filter(([, r]) => isResumable(r)).map(([n]) => n));
    // spec 221 — for each STOPPED resumable agent (the badge only renders for stopped/crashed, so
    // never probe a running one — that would rescan jsonl titles every refresh for nothing), probe
    // whether the transcript is actually on disk so the badge is honest: "resumable" (context ready)
    // vs "fresh start" (↻ would degrade to fresh). Small set, read-only; common case = a single stat.
    const runningNames = new Set(all.filter((a) => a.running).map((a) => a.name));
    const resumeReadyOf = new Map<string, boolean>();
    await Promise.all(
      [...resumableNames]
        .filter((name) => !runningNames.has(name))
        .map(async (name) => {
          const rec = ws.ledger.get(name);
          if (rec) resumeReadyOf.set(name, await ws.manager.resumeReadiness(name, rec));
        }),
    );
    // spec 210 — agents running in their own worktree, with the branch for the ⎇ badge.
    const worktreeBranchOf = new Map([...ws.ledger.all()].filter(([, r]) => r.worktree).map(([n, r]) => [n, r.worktree!.branch]));
    // spec 214 — the verify-gate badge for each worktree agent with a declared `verify:` (probes
    // git HEAD/dirty for staleness; small set, so a couple git reads per refresh is cheap).
    const verifyInfoOf = new Map<string, VerifyRender>();
    await Promise.all(
      [...worktreeBranchOf.keys()].map(async (name) => {
        const info = await ws.verifyInfo(name);
        if (info) verifyInfoOf.set(name, { badge: info.badge, command: info.command, ranAt: info.state?.ranAt });
      }),
    );
    const childrenOf = (name: string) => all.filter((a) => a.parent === name);
    // spec 225 — a RUNNING agent is forkable iff its runtime has a native session fork (claude) and it
    // isn't self-managing its own session (a `--resume`-style cmd has no Tachyon-tracked id to fork).
    const canForkOf = (name: string): boolean => {
      const def = ws.manager.defOf(name);
      const cmd = def?.cmd;
      // spec 226 — forking a harness agent is blocked in the manager (v1); don't offer the action.
      return !!cmd && !def?.harness && forkable(adapterFor(cmd)) && !managesOwnSession(cmd);
    };
    // spec 226 — an agent declares an isolated harness (its own MCP config home) → ⚙ badge.
    const hasHarnessOf = (name: string): boolean => !!ws.manager.defOf(name)?.harness;
    const toItem = (a: (typeof all)[number]) =>
      new AgentTreeItem(
        ws,
        a.name,
        { running: a.running, declared: a.declared, dead: a.dead, crashed: a.crashed, exitCode: a.exitCode, kind: a.kind },
        ws.attentionOf(a.name),
        Date.now(),
        childrenOf(a.name).length > 0,
        a.parent && present.has(a.parent) ? a.parent : undefined,
        !a.running && resumableNames.has(a.name),
        worktreeBranchOf.get(a.name),
        verifyInfoOf.get(a.name),
        resumableNames.has(a.name) ? resumeReadyOf.get(a.name) : undefined,
        a.running && a.kind === "agent" && canForkOf(a.name),
        hasHarnessOf(a.name),
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

    const bridge = bridgeItem(ws);

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
    // Stable identity (F4): without an id VS Code derives it from the label, so editing a
    // pin's text would lose its selection/checkbox state on refresh.
    this.id = `tachyon-pin-${ws.wsHash}-${pinId}`;
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

  /** Notes shortcut + the shared checklist, for the unified tree's "Pins" category. */
  pinsOf(ws: Workspace): vscode.TreeItem[] {
    return this.rootsOf(ws);
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

function relTime(ms: number, now = Date.now()): string {
  const d = Math.round((ms - now) / 1000);
  const abs = Math.abs(d);
  const unit = abs < 90 ? `${abs}s` : abs < 5400 ? `${Math.round(abs / 60)}m` : `${Math.round(abs / 3600)}h`;
  return d >= 0 ? `in ${unit}` : `${unit} ago`;
}

function scheduleSummary(def: { every?: string; at?: string; run?: string; spawn?: string }): string {
  const when = def.every ? `every ${def.every}` : `at ${def.at}`;
  const what = def.run ? `run ${def.run}` : `spawn ${def.spawn}`;
  return `${when} · ${what}`;
}

export class ScheduleTreeItem extends vscode.TreeItem {
  constructor(
    public readonly ws: Workspace,
    public readonly scheduleName: string,
    def: { every?: string; at?: string; run?: string; spawn?: string },
    nextRun?: number,
    lastRun?: number,
    paused = false,
  ) {
    super(scheduleName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = paused ? "schedule-paused" : "schedule";
    this.iconPath = paused
      ? new vscode.ThemeIcon("debug-pause", new vscode.ThemeColor("disabledForeground"))
      : new vscode.ThemeIcon("clock", new vscode.ThemeColor("charts.green"));
    const status = paused ? vscode.l10n.t("paused") : nextRun !== undefined ? vscode.l10n.t("next {0}", relTime(nextRun)) : "";
    this.description = `${scheduleSummary(def)}${status ? " · " + status : ""}`;
    this.tooltip = lastRun !== undefined ? vscode.l10n.t("last fired {0}", relTime(lastRun)) : vscode.l10n.t("not fired yet this session");
  }
}

export class ProposalTreeItem extends vscode.TreeItem {
  constructor(
    public readonly ws: Workspace,
    public readonly proposalId: string,
    proposalName: string,
    by: string,
    def: { every?: string; at?: string; run?: string; spawn?: string },
    reason?: string,
  ) {
    super(proposalName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "proposal";
    this.iconPath = new vscode.ThemeIcon("question", new vscode.ThemeColor("charts.yellow"));
    this.description = vscode.l10n.t("{0} — proposed by {1}", scheduleSummary(def), by);
    this.tooltip = (reason ? `${reason}\n\n` : "") + vscode.l10n.t("awaiting your approval — ✓ approve / ✗ reject");
  }
}

/** "Schedules" view: active timers + pending agent proposals (approve/reject). */
export class SchedulesProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
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
      return all.map((ws) => new FolderTreeItem(ws, "schedules"));
    }
    if (element instanceof FolderTreeItem) return this.rootsOf(element.ws);
    if (element.contextValue === "group-schedules") {
      const ws = (element as GroupTreeItem).ws;
      return ws.scheduler.list().map((s) => new ScheduleTreeItem(ws, s.name, s.def, s.nextRun, s.lastRun, s.paused));
    }
    if (element.contextValue === "group-proposals") {
      const ws = (element as GroupTreeItem).ws;
      return ws.proposals.list().map((p) => new ProposalTreeItem(ws, p.id, p.name, p.by, p.schedule, p.reason));
    }
    return [];
  }

  private rootsOf(ws: Workspace): vscode.TreeItem[] {
    const active = ws.scheduler.list();
    let pending: ReturnType<typeof ws.proposals.list> = [];
    try {
      pending = ws.proposals.list();
    } catch {
      const broken = new vscode.TreeItem(vscode.l10n.t("schedules-pending.json is invalid"));
      broken.iconPath = new vscode.ThemeIcon("warning");
      return [broken];
    }
    const out: vscode.TreeItem[] = [];
    if (pending.length > 0) {
      const g = new GroupTreeItem(ws, vscode.l10n.t("Pending approval"), "group-proposals", "question");
      g.description = `${pending.length}`;
      out.push(g);
    }
    if (active.length > 0) {
      out.push(new GroupTreeItem(ws, vscode.l10n.t("Schedules"), "group-schedules", "clock"));
    }
    if (out.length === 0) {
      const hint = new vscode.TreeItem(vscode.l10n.t("No schedules in tachyon.yml"));
      hint.iconPath = new vscode.ThemeIcon("info");
      out.push(hint);
    }
    return out;
  }
}

export interface TachyonSubProviders {
  agents: AgentsProvider;
  schedules: SchedulesProvider;
  commands: CommandsProvider;
  pins: PinsProvider;
}

/**
 * The single unified Tachyon tree: one view, every domain as an always-visible,
 * individually-collapsible category (Agents / Terminals / Schedules / Commands /
 * Runbooks / Pins), with the Bridge status line on top, outside any category.
 *
 * Leaf rows are produced by the per-domain providers (reused as routers) so the
 * item logic stays in one place; this class owns the category spine and the
 * always-visible "(none)" placeholders. The sub-providers' refresh events fan
 * out to this tree, so the existing dozens of `*.refresh()` call sites keep
 * working without rewiring.
 */
export class TachyonProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly getWorkspaces: GetWorkspaces,
    private readonly subs: TachyonSubProviders,
  ) {
    for (const p of [subs.agents, subs.schedules, subs.commands, subs.pins]) {
      p.onDidChangeTreeData(() => this.emitter.fire());
    }
  }

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
      return all.map((ws) => new FolderTreeItem(ws, "tachyon"));
    }
    if (element instanceof FolderTreeItem) return this.rootsOf(element.ws);

    const ctx = element.contextValue;
    if (element instanceof AgentTreeItem || ctx === "group-agents" || ctx === "group-terminals") {
      return this.fill(await this.subs.agents.getChildren(element), ctx);
    }
    if (ctx === "group-schedules" || ctx === "group-proposals") {
      return this.fill(await this.subs.schedules.getChildren(element), ctx);
    }
    if (element instanceof RunbookTreeItem || ctx === "group-commands" || ctx === "group-runbooks") {
      return this.fill(await this.subs.commands.getChildren(element), ctx);
    }
    if (ctx === "group-pins") {
      return this.subs.pins.pinsOf((element as GroupTreeItem).ws);
    }
    if (ctx === "group-pipelines") {
      const plws = (element as GroupTreeItem).ws;
      const activeOf = (name: string) => plws.pipelines.allRuns().find((r) => r.pipeline.name === name && runStatus(r) !== "completed");
      return this.fill(
        plws.listPipelines().map((name) => new PipelineDefTreeItem(plws, name, activeOf(name))),
        ctx,
      );
    }
    if (element instanceof PipelineDefTreeItem) {
      const run = element.run;
      if (!run) return [];
      return Object.entries(run.nodes).map(
        ([nodeId, st]) =>
          new PipelineNodeTreeItem(element.ws, run.id, nodeId, st.status, st.reason, nodeSpawnName(run.id, nodeId, run.pipeline.nodes[nodeId] ?? {})),
      );
    }
    return [];
  }

  /** Empty CATEGORY nodes get a muted placeholder; empty leaf expansions
   *  (lineage, runbook steps) legitimately stay empty. */
  private fill(kids: vscode.TreeItem[], ctx?: string): vscode.TreeItem[] {
    const isGroup = ctx?.startsWith("group-");
    return kids.length > 0 || !isGroup ? kids : [emptyHint(vscode.l10n.t("(none)"))];
  }

  private async rootsOf(ws: Workspace): Promise<vscode.TreeItem[]> {
    const all = await ws.manager.list();
    const desc = (kind: "agent" | "terminal") => {
      const m = all.filter((a) => a.kind === kind);
      return `${m.filter((x) => x.running).length}/${m.length}`;
    };
    let pending = 0;
    try {
      pending = ws.proposals.list().length;
    } catch {
      pending = 0;
    }

    const out: vscode.TreeItem[] = [bridgeItem(ws)];

    const ag = new GroupTreeItem(ws, vscode.l10n.t("Agents"), "group-agents", "hubot");
    ag.description = desc("agent");
    out.push(ag);

    const tm = new GroupTreeItem(ws, vscode.l10n.t("Terminals"), "group-terminals", "terminal");
    tm.description = desc("terminal");
    out.push(tm);

    if (pending > 0) {
      const pr = new GroupTreeItem(ws, vscode.l10n.t("Pending approval"), "group-proposals", "question");
      pr.description = `${pending}`;
      out.push(pr);
    }
    const pipelineNames = ws.listPipelines();
    if (pipelineNames.length > 0) {
      const pl = new GroupTreeItem(ws, vscode.l10n.t("Pipelines"), "group-pipelines", "run-all");
      const active = ws.pipelines.allRuns().filter((r) => runStatus(r) !== "completed").length;
      pl.description = active > 0 ? `${pipelineNames.length} · ${active} active` : `${pipelineNames.length}`;
      out.push(pl);
    }
    out.push(new GroupTreeItem(ws, vscode.l10n.t("Schedules"), "group-schedules", "clock"));
    out.push(new GroupTreeItem(ws, vscode.l10n.t("Commands"), "group-commands", "terminal-cmd"));
    out.push(new GroupTreeItem(ws, vscode.l10n.t("Runbooks"), "group-runbooks", "checklist"));
    out.push(new GroupTreeItem(ws, vscode.l10n.t("Pins"), "group-pins", "pinned"));
    return out;
  }
}
