import * as vscode from "vscode";
import type { Workspace } from "../workspace/Workspace.js";
import { isResumable } from "../resume/SessionLedger.js";
import { adapterFor, forkable, managesOwnSession } from "../resume/adapters.js";
import type { FleetVM, AgentStatus, Verify, AgentVM, RunState } from "../sidebar/types.js";
import { toAgentVM } from "../sidebar/agentModel.js";
import type { ActionId } from "../sidebar/actions.js";
import { agentContextValue } from "../presentation/contextValue.js";
import { runStatus } from "../pipeline/runState.js";
import { nodeSpawnName } from "../pipeline/loadPipeline.js";

/** Relative time like "in 5m" / "12s ago" (was in the tree; lives here now that the tree is gone). */
function relTime(ms: number, now = Date.now()): string {
  const d = Math.round((ms - now) / 1000);
  const abs = Math.abs(d);
  const unit = abs < 90 ? `${abs}s` : abs < 5400 ? `${Math.round(abs / 60)}m` : `${Math.round(abs / 3600)}h`;
  return d >= 0 ? `in ${unit}` : `${unit} ago`;
}
/** Human cadence summary for a schedule/proposal def, e.g. "every 1h · run lint". */
function scheduleSummary(def: { every?: string; at?: string; run?: string; spawn?: string }): string {
  const when = def.every ? `every ${def.every}` : `at ${def.at}`;
  const what = def.run ? `run ${def.run}` : `spawn ${def.spawn}`;
  return `${when} · ${what}`;
}

/** Messages the webview posts to the host. */
type SidebarMsg = {
  type?: "ready" | "action" | "section" | "global" | "pipeline";
  id?: string;
  agent?: string;
  op?: string;
  done?: boolean;
  label?: string;
  name?: string;
  nodeId?: string;
  hash?: string;
};

/** Maps a webview action id → the existing VS Code command (which takes a {ws, agentName, contextValue} item;
 *  no AgentTreeItem instance needed — the handlers only read those fields). `inspect` is special (it takes
 *  (agent, hash), not an item). */
const ACTION_CMD: Record<Exclude<ActionId, "inspect">, string> = {
  kill: "tachyon.killAgentItem",
  restart: "tachyon.restartAgentItem",
  spawn: "tachyon.spawnAgentItem",
  resume: "tachyon.resumeAgentItem",
  fork: "tachyon.forkAgentItem",
  verify: "tachyon.verifyAgentItem",
  reanchor: "tachyon.reanchorAgentItem",
  promote: "tachyon.promoteAgentItem",
  reviewWorktree: "tachyon.reviewWorktreeItem",
  createPr: "tachyon.createWorktreePrItem",
  removeWorktree: "tachyon.removeWorktreeItem",
  edit: "tachyon.editAgentStudioItem",
  editYaml: "tachyon.editAgentItem",
  clone: "tachyon.cloneAgentItem",
  rename: "tachyon.renameAgentItem",
  delete: "tachyon.deleteAgentItem",
};

/**
 * spec 237 — the Tachyon sidebar webview (Preact). The host glue: serves the shell HTML (CSP + the VS Code
 * theme CSS + codicon font), loads the bundled Preact app (`dist/webview/sidebar.js`), and pushes the LIVE
 * fleet model to it via postMessage (gathered from the workspace managers across all sections). All UI lives
 * in the bundle. This is the DEFAULT Tachyon sidebar; the legacy tree is opt-in via
 * `tachyon.sidebar.legacyTree` (deprecated, slated for removal — see docs/specs/237).
 */
export class SidebarPrototypeProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "tachyonSidebarPrototype";
  private view?: vscode.WebviewView;
  private lastFleets: FleetVM[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getWorkspaces: () => Workspace[],
  ) {}

  /** The attention/proposal count badge on the view container (moved off the retired tree). */
  setBadge(n: number, tooltip: string): void {
    if (this.view) this.view.badge = n > 0 ? { value: n, tooltip } : undefined;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    const codiconUri = view.webview.asWebviewUri(vscode.Uri.joinPath(root, "codicon.css"));
    const sidebarUri = view.webview.asWebviewUri(vscode.Uri.joinPath(root, "sidebar.js"));
    view.webview.html = html(view.webview, codiconUri, sidebarUri);
    view.webview.onDidReceiveMessage((m: SidebarMsg) => void this.handleMessage(m));
    view.onDidDispose(() => { if (this.view === view) this.view = undefined; });
  }

  /** Resolve the workspace an action targets — its folder hash (multi-root), or the first when unspecified. */
  private wsFor(hash?: string): Workspace | undefined {
    const wss = this.getWorkspaces();
    return wss.find((w) => w.wsHash === hash) ?? wss[0];
  }

  /** Re-gather + push the live fleets (one per workspace root) to the webview (wired into refreshAll). */
  refresh(): void {
    void this.push();
  }

  private async push(): Promise<void> {
    const view = this.view;
    if (!view) return;
    this.lastFleets = await Promise.all(this.getWorkspaces().map((ws) => this.gatherOne(ws)));
    void view.webview.postMessage({ type: "fleet", fleets: this.lastFleets });
  }

  private async handleMessage(m: SidebarMsg): Promise<void> {
    if (m?.type === "ready") return void this.push();
    if (m?.type === "action" && m.id && m.agent) return this.runAction(m.id as ActionId, m.agent, m.hash);
    if (m?.type === "global") {
      // The "new …" studios pick the target folder themselves (pickFolderForCreate) → no ws/hash needed.
      const STUDIO: Record<string, string> = {
        "studio:agents": "tachyon.agentStudio", "studio:terminals": "tachyon.terminalStudio",
        "studio:commands": "tachyon.commandStudio", "studio:runbooks": "tachyon.runbookStudio",
        "studio:schedules": "tachyon.scheduleStudio",
      };
      if (m.op && STUDIO[m.op]) return void vscode.commands.executeCommand(STUDIO[m.op]);
      if (m.op === "copyBridge") return void vscode.commands.executeCommand("tachyon.copyBridgeUrl", m.hash);
      const ws = this.wsFor(m.hash);
      if (ws) void vscode.commands.executeCommand(m.op === "addPin" ? "tachyon.addPin" : "tachyon.openNotes", { ws });
      return;
    }
    if (m?.type === "section" && m.op && m.id) return this.runSection(m.op, m.id, m.done, m.label, m.hash);
    if (m?.type === "pipeline" && m.op && m.name) return this.runPipeline(m.op, m.name, m.nodeId, m.hash);
  }

  /** Route a section-row action to its existing VS Code command (duck-typed item) or store mutation. */
  private runSection(op: string, id: string, done?: boolean, label?: string, wsHash?: string): void {
    const ws = this.wsFor(wsHash);
    if (!ws) return;
    const exec = (cmd: string, item: Record<string, unknown>) => void vscode.commands.executeCommand(cmd, item);
    switch (op) {
      case "command:run": return exec("tachyon.runCommandItem", { ws, commandName: id });
      case "command:open": return void vscode.commands.executeCommand("tachyon.openCommandTerminalItem", id, ws.wsHash);
      case "command:edit": return exec("tachyon.editCommandStudioItem", { ws, commandName: id });
      case "command:editYaml": return exec("tachyon.editCommandItem", { ws, commandName: id });
      case "command:delete": return exec("tachyon.deleteCommandItem", { ws, commandName: id });
      case "runbook:run": return exec("tachyon.runRunbookItem", { ws, runbookName: id });
      case "runbook:edit": return exec("tachyon.editRunbookStudioItem", { ws, runbookName: id });
      case "runbook:editYaml": return exec("tachyon.editRunbookItem", { ws, runbookName: id });
      case "runbook:delete": return exec("tachyon.deleteRunbookItem", { ws, runbookName: id });
      case "runbook:step": { const hash = id.indexOf("#"); return void vscode.commands.executeCommand("tachyon.openRunbookStepItem", id.slice(0, hash), Number(id.slice(hash + 1)), ws.wsHash); }
      case "pin:toggle": ws.pinStore.setDone(id, !!done); return void this.push();
      case "pin:edit": return exec("tachyon.editPinItem", { ws, pinId: id });
      case "pin:delete": return exec("tachyon.deletePinItem", { ws, pinId: id });
      case "schedule:pause": return exec("tachyon.toggleSchedulePauseItem", { ws, scheduleName: id });
      case "schedule:edit": return exec("tachyon.editScheduleStudioItem", { ws, scheduleName: id });
      case "schedule:editYaml": return exec("tachyon.editScheduleItem", { ws, scheduleName: id });
      case "schedule:delete": return exec("tachyon.deleteScheduleItem", { ws, scheduleName: id });
      case "proposal:approve": return exec("tachyon.approveProposalItem", { ws, proposalId: id });
      case "proposal:reject": return exec("tachyon.rejectProposalItem", { ws, proposalId: id, label: label ?? id });
    }
  }

  /** Route a pipeline action (def- or node-level). The provider looks up the active run server-side so the
   *  command handlers get the {ws, pipelineName, run} / {ws, runId, nodeId, run} item they expect. */
  private runPipeline(op: string, name: string, nodeId?: string, wsHash?: string): void {
    const ws = this.wsFor(wsHash);
    if (!ws) return;
    const exec = (cmd: string, item: Record<string, unknown>) => void vscode.commands.executeCommand(cmd, item);
    const run = ws.pipelines.allRuns().find((r) => r.pipeline.name === name && runStatus(r) !== "completed");
    const def = { ws, pipelineName: name, run };
    const node = { ws, runId: run?.id, nodeId, run };
    switch (op) {
      case "run": return exec("tachyon.runPipelineItem", def);
      case "cancel": return exec("tachyon.cancelPipelineItem", def);
      case "dismiss": return exec("tachyon.dismissPipelineRunItem", def);
      case "review": return exec("tachyon.reviewPipelineItem", def);
      case "editInput": return exec("tachyon.editPipelineInputItem", def);
      case "edit": return exec("tachyon.editPipelineItem", def);
      case "delete": return exec("tachyon.deletePipelineItem", def);
      case "node:approve": return exec("tachyon.approvePipelineNodeItem", node);
      case "node:reject": return exec("tachyon.rejectPipelineNodeItem", node);
      case "node:rerun": return exec("tachyon.rerunPipelineNodeItem", node);
      case "node:review": return exec("tachyon.reviewPipelineItem", node);
      case "node:inspect": { // open the node agent's terminal (best-effort; a dismissed cmd node has none)
        if (run && nodeId) void vscode.commands.executeCommand("tachyon.openAgentTerminalItem", nodeSpawnName(run.id, nodeId, run.pipeline.nodes[nodeId] ?? {}), ws.wsHash);
        return;
      }
    }
  }

  /** Run an agent action by invoking the existing VS Code command with a duck-typed {ws, agentName,
   *  contextValue} item — the same shape the tree passes; the tree never has to exist for this to work. */
  private runAction(id: ActionId, agent: string, wsHash?: string): void {
    const ws = this.wsFor(wsHash);
    if (!ws) return;
    if (id === "inspect") { void vscode.commands.executeCommand("tachyon.openAgentTerminalItem", agent, ws.wsHash); return; }
    const fleet = this.lastFleets.find((f) => f.folder?.hash === ws.wsHash);
    const vm = fleet?.agents.find((x) => x.name === agent) ?? fleet?.terminals.find((x) => x.name === agent);
    const item = { ws, agentName: agent, contextValue: vm ? ctxOf(vm) : `agent-running` };
    void vscode.commands.executeCommand(ACTION_CMD[id], item);
  }

  /** Build one workspace's live view-model (the webview groups by folder when there's more than one). */
  private async gatherOne(ws: Workspace): Promise<FleetVM> {
    const all = await ws.manager.list();
    const ledger = [...ws.ledger.all()];
    const resumable = new Set(ledger.filter(([, r]) => isResumable(r)).map(([n]) => n));
    const worktrees = new Map(ledger.filter(([, r]) => r.worktree).map(([n, r]) => [n, r.worktree!.branch]));
    const canFork = (name: string, running: boolean, kind: string): boolean => {
      if (!running || kind !== "agent") return false;
      const def = ws.manager.defOf(name);
      const cmd = def?.cmd;
      return !!cmd && !def?.harness && forkable(adapterFor(cmd)) && !managesOwnSession(cmd);
    };
    // verify-gate state for worktree agents (small set), like the tree does it.
    const verifyOf = new Map<string, Verify>();
    await Promise.all([...worktrees.keys()].map(async (name) => {
      const info = await ws.verifyInfo(name);
      if (info) verifyOf.set(name, info.badge === "verified" ? "pass" : info.badge === "failing" ? "fail" : "stale");
    }));
    // spec 221 — for each resumable, stopped agent, whether the transcript is still on disk (↻ restores
    // context) vs gone (↻ degrades to fresh). Small set, read-only — same probe the tree does.
    const running = new Set(all.filter((a) => a.running).map((a) => a.name));
    const resumeReadyOf = new Map<string, boolean>();
    await Promise.all([...resumable].filter((n) => !running.has(n)).map(async (name) => {
      const rec = ws.ledger.get(name);
      if (rec) resumeReadyOf.set(name, await ws.manager.resumeReadiness(name, rec));
    }));
    const agents = all
      .filter((a) => a.kind === "agent")
      .map((a) => toAgentVM(a, {
        attention: ws.attentionOf(a.name)?.state,
        worktree: worktrees.get(a.name),
        verify: verifyOf.get(a.name),
        verifiable: verifyOf.has(a.name),
        harness: !!ws.manager.defOf(a.name)?.harness,
        fork: canFork(a.name, a.running, a.kind),
        resumable: !a.running && resumable.has(a.name),
        freshStart: !a.running && resumable.has(a.name) && resumeReadyOf.get(a.name) === false,
        ai: true,
        adhoc: !a.declared,
      }));
    // Terminals are non-AI agents (ai:false) → same model + action matrix, reduced set (no resume-context/
    // fork/verify/re-anchor). A stopped terminal thus gets ▶ Start; a running one Open/Restart/Kill.
    const terminals = all
      .filter((a) => a.kind === "terminal")
      .map((a) => {
        const vm = toAgentVM(a, { ai: false, adhoc: !a.declared, resumable: !a.running && resumable.has(a.name) });
        const cmd = ws.manager.defOf(a.name)?.cmd;
        return cmd && !vm.sub ? { ...vm, sub: cmd } : vm;
      });
    const bridge = { port: ws.bridge.port?.toString() ?? "—", connected: !!ws.bridge.url };

    // Other sections — live, read-only (no per-row actions yet). Secondary fields are best-effort.
    const commands = (await ws.commandRunner.list()).map((c) => {
      const dur = c.lastRun?.finishedAt !== undefined ? c.lastRun.finishedAt - c.lastRun.startedAt : undefined;
      const detail =
        c.state === "running" ? "running"
          : c.state === "passed" ? (dur !== undefined ? `exit 0 · ${Math.round(dur / 1000)}s` : "exit 0")
            : c.state === "failed" ? `exit ${c.exitCode ?? "?"}`
              : "never run";
      return { name: c.name, cmd: ws.config?.commands?.[c.name]?.cmd ?? "", state: c.state, detail };
    });
    const runbooks = ws.runbookRunner.list().map((r) => {
      const job = r.lastJob;
      const failed = job?.outcome === "failed";
      const detail = r.running ? "running"
        : job?.outcome === "passed" ? `passed · ${job.steps.length} steps`
          : failed ? `failed at step ${(job.steps.find((s) => s.state === "failed")?.index ?? 0) + 1}`
            : "never run";
      const steps = (job?.steps ?? []).map((s) => ({
        n: s.index + 1,
        label: s.step,
        state: s.state,
        detail: s.state === "passed" ? (s.durationMs !== undefined ? `${Math.round(s.durationMs / 1000)}s` : undefined)
          : s.state === "failed" ? `exit ${s.exitCode ?? "?"}` : undefined,
      }));
      return { name: r.name, running: r.running, failed, detail, steps };
    });
    const pins = ws.pinStore.list().map((p) => ({ id: p.id, text: p.text, done: p.done, by: p.by }));
    const firstLine = ws.pinStore.getNotes().split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
    const notes = firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine;
    const proposals = ws.proposals.list().map((p) => ({ id: p.id, name: p.name, by: p.by, reason: p.reason, when: scheduleSummary(p.schedule) }));
    const schedules = ws.scheduler.list().map((s) => ({
      name: s.name,
      when: scheduleSummary(s.def as { every?: string; at?: string; run?: string; spawn?: string }),
      next: s.paused ? "paused" : s.nextRun ? `next ${relTime(s.nextRun)}` : "not scheduled",
      paused: !!s.paused,
    }));
    const pipelines = ws.listPipelines().map((name) => {
      const run = ws.pipelines.allRuns().find((r) => r.pipeline.name === name && runStatus(r) !== "completed");
      const nodes = run ? Object.entries(run.nodes).map(([id, st]) => ({ id, status: nodeStatus(st.status), label: String(st.status), reason: st.reason })) : [];
      // run is guaranteed non-completed here → status is idle|running|paused|failed.
      const status = (run ? runStatus(run) : "idle") as RunState;
      return { name, status, nodes };
    });
    return { folder: { hash: ws.wsHash, name: ws.folderName }, bridge, agents, terminals, commands, runbooks, pins, notes, schedules, pipelines, proposals };
  }
}

/** Map a pipeline node status to the sidebar dot color bucket. */
function nodeStatus(s: string): AgentStatus {
  return s === "running" ? "running" : s === "done" || s === "completed" ? "idle" : s === "failed" ? "crashed" : "stopped";
}

/** Reconstruct the contextValue the command handlers expect, from the agent VM's capability flags. */
function ctxOf(a: AgentVM): string {
  const state = a.status === "crashed" ? "crashed" : a.status === "stopped" ? "stopped" : "running";
  return agentContextValue({ state, ai: !!a.ai, adhoc: !!a.adhoc, worktree: !!a.worktree, verifiable: !!a.verifiable, forkable: !!a.fork, harness: !!a.harness });
}

function getNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function html(webview: vscode.Webview, codiconUri: vscode.Uri, sidebarUri: vscode.Uri): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconUri}">
<style>
  :root {
    --hover: var(--vscode-list-hoverBackground);
    --sel: var(--vscode-list-inactiveSelectionBackground, var(--vscode-list-hoverBackground));
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-widget-border, var(--vscode-editorWidget-border, rgba(128,128,128,.22)));
    --focus: var(--vscode-focusBorder);
    --ok: var(--vscode-testing-iconPassed, #4caf50);
    --warn: var(--vscode-list-warningForeground, #cca700);
    --err: var(--vscode-list-errorForeground, #f14c4c);
    --idle: var(--vscode-disabledForeground, #8a8a8a);
  }
  * { box-sizing: border-box; }
  html, body { overflow-x: hidden; }
  body { margin: 0; padding: 6px 0 28px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  /* a11y: interactive controls are real <button>s — reset to inherit + a visible keyboard focus ring */
  button { font: inherit; color: inherit; background: none; border: none; padding: 0; margin: 0; cursor: pointer; }
  :focus-visible { outline: 1px solid var(--focus); outline-offset: -1px; border-radius: 3px; }

  /* multi-root folder picker (only shown when >1 workspace) */
  /* Multi-root: one collapsible group per folder, all shown at once (mirrors the old tree grouping) */
  /* Folder header (multi-root) is its own clickable role=button div (not a Group) — needs its own layout */
  .grp.folder { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; font-size: 11px; color: var(--vscode-foreground); font-weight: 600; padding: 9px 12px 4px; border-top: 1px solid var(--border); }
  .grp.folder:first-child { border-top: 0; }
  .grp.folder:focus-visible { outline: 1px solid var(--focus); outline-offset: -1px; }
  .grp.folder .codicon { font-size: 13px; opacity: .8; }
  .folder-body { padding-bottom: 4px; }

  /* cmd+K trigger — styled as an Agent-Studio input */
  .kbar { margin: 4px 8px 6px; display: flex; align-items: center; gap: 6px; padding: 5px 8px; background: var(--vscode-input-background); color: var(--muted); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 3px; cursor: text; }
  .kbar:hover { border-color: var(--focus); }
  .kbar .codicon { font-size: 13px; }
  .kbar .kgrow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .kbar .kbd { font-size: 10px; border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; opacity: .85; }

  /* Icon tabs — equal width, never overflow */
  .tabs { display: flex; gap: 1px; padding: 0 6px; border-bottom: 1px solid var(--border); }
  .tab { flex: 1 1 0; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 3px; padding: 6px 0 7px; cursor: pointer; color: var(--muted); position: relative; border-bottom: 2px solid transparent; }
  .tab:hover { color: var(--vscode-foreground); }
  .tab.active { color: var(--vscode-foreground); border-bottom-color: var(--focus); }
  .tab .codicon { font-size: 16px; }
  .tab .cnt { font-size: 9px; opacity: .6; }

  /* active section title */
  .sec { display: flex; align-items: baseline; gap: 6px; padding: 9px 12px 2px; }
  .sec b { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .sec .scount { color: var(--muted); font-size: 11px; opacity: .7; }
  .sec .sec-new { margin-left: auto; }

  .panel { display: none; }
  .panel.active { display: block; }

  /* Status group headers */
  .grp { position: relative; }
  .grp-toggle { display: flex; align-items: center; gap: 6px; width: 100%; padding: 7px 12px 3px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; cursor: pointer; user-select: none; background: none; border: 0; font-family: inherit; text-align: left; }
  .grp-toggle:focus-visible { outline: 1px solid var(--focus); outline-offset: -1px; }
  .grp .chev { font-size: 9px; transition: transform .12s; opacity: .8; }
  .grp.collapsed .chev { transform: rotate(-90deg); }
  .grp .gcount { margin-left: auto; opacity: .65; }
  /* Overlay the header actions (absolute) so revealing them on hover never changes the header height. */
  .grp-actions { display: none; position: absolute; right: 8px; top: 50%; transform: translateY(-50%); gap: 0; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); padding: 1px 2px; border-radius: 4px; box-shadow: 0 0 0 1px var(--border); }
  .grp:hover .grp-actions { display: flex; }
  .grp-actions .act { width: 20px; height: 20px; }
  .grp.collapsed + .grp-body { display: none; }

  /* Rows — 2 lines; meta wraps; never overflows */
  .row { display: flex; flex-direction: column; gap: 1px; padding: 4px 12px; position: relative; }
  .row:hover { background: var(--hover); }
  .row.flash, .pin.flash { animation: flash 1s ease-out; }
  @keyframes flash { 0%,28% { background: var(--sel); } 100% { background: transparent; } }
  .row-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .sdot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .sdot.running { background: var(--ok); }
  .sdot.needs { background: var(--warn); box-shadow: 0 0 5px var(--warn); }
  .sdot.idle { background: var(--idle); }
  .sdot.stopped { background: transparent; border: 1px solid var(--idle); }
  .sdot.crashed { background: var(--err); }
  .name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .row.child { padding-left: 26px; }
  .row.child::before { content: "↳"; position: absolute; left: 13px; top: 4px; color: var(--muted); opacity: .7; }
  .row-meta { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; padding-left: 15px; }
  .row-meta:empty { display: none; }
  .msub { color: var(--muted); font-size: 11px; }
  /* Badges: muted by default — color reserved for status semantics (attention / verify) */
  .badge { font-size: 10px; line-height: 1.5; padding: 0 5px; border-radius: 3px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .badge.attn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 55%, transparent); }
  .badge.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 55%, transparent); }
  .badge.err { color: var(--err); border-color: color-mix(in srgb, var(--err) 55%, transparent); }
  .badge.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 55%, transparent); }

  /* hover action overlay — toolbar idiom; absolute so it never widens the row */
  .actions { display: none; position: absolute; right: 8px; top: 2px; gap: 0; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); padding: 1px 2px; border-radius: 4px; box-shadow: 0 0 0 1px var(--border); }
  .row:hover .actions { display: flex; }
  .act { width: 22px; height: 22px; display: grid; place-items: center; border-radius: 4px; cursor: pointer; color: var(--muted); }
  .act .codicon { font-size: 14px; }
  .act:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); color: var(--vscode-foreground); }

  .empty { padding: 10px 14px; color: var(--muted); font-style: italic; font-size: 12px; }
  /* Notes as a row (click → open the shared notes file), like the tree */
  .notes-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 12px; background: none; border: 0; color: inherit; font: inherit; cursor: pointer; text-align: left; }
  .notes-row:hover { background: var(--hover); }
  .notes-row .name { font-weight: 600; }
  .notes-row .msub { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pin { display: flex; gap: 8px; padding: 5px 12px; align-items: flex-start; position: relative; }
  .pin:hover { background: var(--hover); }
  .pin:hover .actions { display: flex; }
  .pin-body { min-width: 0; display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: baseline; }
  .pin-by { color: var(--muted); opacity: .8; font-size: 11px; }
  /* The checkbox is a real focusable button (role=checkbox) — keyboard + screen-reader state */
  .pin .box { width: 13px; height: 13px; padding: 0; border: 1px solid var(--muted); border-radius: 3px; flex: none; margin-top: 2px; display: grid; place-items: center; cursor: pointer; background: none; color: inherit; }
  .pin .box:focus-visible { outline: 1px solid var(--focus); outline-offset: 1px; }
  .pin .box.done { background: var(--ok); border-color: var(--ok); color: var(--vscode-editor-background); }
  .pin .box .codicon { font-size: 11px; }
  .pin.done .txt { text-decoration: line-through; color: var(--muted); }

  /* Bridge — quiet footer status bar */
  .foot { position: fixed; bottom: 0; left: 0; right: 0; display: flex; flex-direction: column; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-top: 1px solid var(--border); font-size: 11px; }
  /* Each bridge is a full-width button: click copies its URL (one per workspace root in multi-root). */
  .bridge-line { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 12px; background: none; border: 0; color: inherit; font: inherit; cursor: pointer; text-align: left; }
  .bridge-line + .bridge-line { border-top: 1px solid var(--border); }
  .bridge-line:hover { background: var(--hover); }
  .bridge-line .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 6px var(--ok); flex: none; }
  .bridge-line .dot.off { background: var(--muted); box-shadow: none; }
  .bridge-line b { font-weight: 600; }
  .bridge-line .bfolder { color: var(--muted); opacity: .8; }
  .bridge-line .fmeta { color: var(--muted); margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* cmd+K palette */
  .cmdk { display: none; position: fixed; inset: 0; z-index: 30; background: rgba(0,0,0,.42); }
  .cmdk.open { display: block; }
  .cmdk-panel { position: absolute; top: 8%; left: 8px; right: 8px; background: var(--vscode-quickInput-background, var(--vscode-editor-background)); border: 1px solid var(--focus); border-radius: 6px; overflow: hidden; box-shadow: 0 12px 36px rgba(0,0,0,.5); }
  .cmdk-panel input { width: 100%; padding: 10px 12px; background: transparent; border: none; border-bottom: 1px solid var(--border); color: var(--vscode-foreground); outline: none; font-size: 13px; }
  .cmdk-panel input::placeholder { color: var(--vscode-input-placeholderForeground, var(--muted)); }
  .cmdk-results { max-height: 50vh; overflow-y: auto; padding: 4px 0; }
  .ci-group { padding: 6px 12px 2px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); opacity: .8; }
  .ci { display: flex; align-items: center; gap: 8px; padding: 6px 12px; cursor: pointer; }
  .ci.sel, .ci:hover { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .ci .codicon { font-size: 14px; opacity: .85; flex: none; }
  .ci .ci-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ci .ci-hint { color: var(--muted); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; }
  .ci.sel .ci-hint { color: inherit; opacity: .75; }
  .cmdk-foot { display: flex; gap: 14px; padding: 6px 12px; border-top: 1px solid var(--border); color: var(--muted); font-size: 10px; }
  .cmdk-foot kbd { font-family: inherit; border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; margin-right: 3px; }

  /* in-webview "more" menu (replaces the native QuickPick) */
  .menu-backdrop { position: fixed; inset: 0; z-index: 40; }
  .more-menu { position: fixed; min-width: 172px; background: var(--vscode-menu-background, var(--vscode-editor-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-menu-border, var(--border)); border-radius: 5px; padding: 4px; box-shadow: 0 6px 22px rgba(0,0,0,.45); }
  .more-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 8px; border-radius: 4px; color: inherit; text-align: left; white-space: nowrap; }
  .more-item:hover, .more-item:focus-visible { background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground)); }
  .more-item .codicon { font-size: 14px; opacity: .9; }

  @media (prefers-reduced-motion: reduce) { *, ::before, ::after { animation: none !important; transition: none !important; } }
</style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${sidebarUri}"></script>
</body>
</html>`;
}
