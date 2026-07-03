import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import path from "node:path";
import type { Workspace } from "../workspace/Workspace.js";
import { isResumable } from "../resume/SessionLedger.js";
import { adapterFor, forkable, managesOwnSession } from "../resume/adapters.js";
import type { FleetVM, AgentStatus, Verify, AgentVM, RunState, PinPreviewAttachmentVM, PinPreviewVM, EvidenceBadge } from "../sidebar/types.js";
import { toAgentVM } from "../sidebar/agentModel.js";
import { evidenceBadge } from "../worktree/evidence.js";
import { fleetMessage } from "./sidebar/messages.js";
import { READY } from "./shared/ready.js";
import { renderWebviewShell } from "./shared/shell.js";
import { pinPreviewMessage } from "./pin-preview/messages.js";
import type { ActionId } from "../sidebar/actions.js";
import { agentContextValue } from "../presentation/contextValue.js";
import { runStatus } from "../pipeline/runState.js";
import { nodeSpawnName } from "../pipeline/loadPipeline.js";
import { notify } from "../workspace/notify.js";
import type { TiptapJSON } from "../pins/PinStore.js";
import { PinAttachmentStore } from "../pins/PinAttachmentStore.js";
import * as domainActions from "../workspace/domainActions.js";

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
  type?: "ready" | "action" | "section" | "global" | "pipeline" | "setSort";
  id?: string;
  agent?: string;
  op?: string;
  done?: boolean;
  label?: string;
  name?: string;
  nodeId?: string;
  hash?: string;
  section?: string; // setSort: "agents" | "terminals"
  mode?: string; // setSort: a SortMode
};

/** spec 242 — persisted sidebar sort prefs (global per user, per section). */
type SortPrefs = { agents?: string; terminals?: string };
const SORT_PREFS_KEY = "tachyon.sidebar.sort";

/** Maps a webview action id → the existing VS Code command (which takes a duck-typed {ws, agentName,
 *  contextValue} item — the handlers only read those fields). `inspect` is special (it takes (agent, hash),
 *  not an item). */
const ACTION_CMD: Record<Exclude<ActionId, "inspect" | "activity" | "probes">, string> = {
  stop: "tachyon.stopAgentItem",
  kill: "tachyon.killAgentItem",
  restart: "tachyon.restartAgentItem",
  spawn: "tachyon.spawnAgentItem",
  resume: "tachyon.resumeAgentItem",
  fork: "tachyon.forkAgentItem",
  verify: "tachyon.verifyAgentItem",
  reanchor: "tachyon.reanchorAgentItem",
  reinjectContinuity: "tachyon.reinjectContinuityItem",
  promote: "tachyon.promoteAgentItem",
  reviewWorktree: "tachyon.reviewWorktreeItem",
  createPr: "tachyon.createWorktreePrItem",
  removeWorktree: "tachyon.removeWorktreeItem",
  edit: "tachyon.editAgentStudioItem",
  editYaml: "tachyon.editAgentItem",
  clone: "tachyon.cloneAgentItem",
  rename: "tachyon.renameAgentItem",
  dismiss: "tachyon.deleteAgentItem",
  delete: "tachyon.deleteAgentItem",
};

/**
 * spec 237 — the Tachyon sidebar webview (Preact). The host glue: serves the shell HTML (CSP + the VS Code
 * theme CSS + codicon font), loads the bundled Preact app (`dist/webview/sidebar.js`), and pushes the LIVE
 * fleet model to it via postMessage (gathered from the workspace managers across all sections). All UI lives
 * in the bundle. This is THE Tachyon sidebar — the native tree was retired in spec 237.
 */
export class SidebarPrototypeProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "tachyonSidebarPrototype";
  private view?: vscode.WebviewView;
  private lastFleets: FleetVM[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getWorkspaces: () => Workspace[],
    private readonly memento?: vscode.Memento, // spec 242 — persists the sort prefs (context.globalState)
  ) {}

  private sortCache?: SortPrefs; // synchronous mirror so overlapping setSort writes don't lose a section (codex)
  private sortPrefs(): SortPrefs {
    return (this.sortCache ??= this.memento?.get<SortPrefs>(SORT_PREFS_KEY) ?? {});
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    const uri = (f: string): string => view.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    view.webview.onDidReceiveMessage((m: SidebarMsg) => void this.handleMessage(m));
    // spec 280 — the sidebar VIEW keeps its bespoke CSP via the shell: img `blob:` + script-src nonce-only (no cspSource).
    view.webview.html = renderWebviewShell({
      cspSource: view.webview.cspSource,
      title: "Tachyon",
      styles: [uri("codicon.css"), uri("design-system.css"), uri("sidebar.css")],
      bundle: uri("sidebar.js"),
      mode: "live",
      imgBlob: true,
      scriptCspSource: false,
    });
    void this.push();
    view.onDidDispose(() => { if (this.view === view) this.view = undefined; });
  }

  /** Resolve the workspace an action targets — its folder hash (multi-root), or the first when unspecified. */
  private wsFor(hash?: string): Workspace | undefined {
    const wss = this.getWorkspaces();
    // Only default to the first workspace when NO hash was sent. A supplied-but-unmatched hash (stale
    // message after a folder was removed, or a bad value) must resolve to nothing — never act on ws 0.
    return hash === undefined ? wss[0] : wss.find((w) => w.wsHash === hash);
  }

  /** Re-gather + push the live fleets (one per workspace root) to the webview (wired into refreshAll). */
  refresh(): void {
    void this.push();
  }

  private async push(): Promise<void> {
    const view = this.view;
    if (!view) return;
    this.lastFleets = await Promise.all(this.getWorkspaces().map((ws) => this.gatherOne(ws)));
    // spec 242 — prefs travel WITH the fleet so the first render is already in the saved order (D8 no flicker).
    // spec 278 — built via the shared envelope so a `fleet`-shape drift breaks the build, not the preview harness.
    void view.webview.postMessage(fleetMessage(this.lastFleets, this.sortPrefs()));
  }

  private async handleMessage(m: SidebarMsg): Promise<void> {
    if (m?.type === "ready") return void this.push();
    if (m?.type === "setSort" && (m.section === "agents" || m.section === "terminals") && (m.mode === "name-asc" || m.mode === "name-desc")) {
      // spec 242 (D9) — update the in-memory cache SYNCHRONOUSLY (before the await) so a second overlapping
      // setSort reads the new object, then persist + republish (the validated mode never writes garbage).
      this.sortCache = { ...this.sortPrefs(), [m.section]: m.mode };
      await this.memento?.update(SORT_PREFS_KEY, this.sortCache);
      return void this.push();
    }
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
      if (m.op === "init") return void vscode.commands.executeCommand("tachyon.init");
      if (m.op === "openHandoff") return void vscode.commands.executeCommand("tachyon.openProjectHandoff", m.hash); // spec 245
      if (m.op === "persistenceSettings") return void vscode.commands.executeCommand("tachyon.persistenceSettings", m.hash); // spec 318
      const ws = this.wsFor(m.hash);
      if (ws && m.op === "addPin") void vscode.commands.executeCommand("tachyon.addPin", { ws });
      return;
    }
    if (m?.type === "section" && m.op && m.id) return this.runSection(m.op, m.id, m.done, m.label, m.hash);
    if (m?.type === "pipeline" && m.op && m.name) return this.runPipeline(m.op, m.name, m.nodeId, m.hash);
  }

  /** Route a section-row action to its existing VS Code command (duck-typed item) or store mutation. */
  private async runSection(op: string, id: string, done?: boolean, label?: string, wsHash?: string): Promise<void> {
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
      case "pin:toggle": domainActions.togglePinDone(ws, id, !!done, { onChanged: () => this.refresh() }); return;
      case "pin:preview": return void this.previewPin(ws, id);
      case "pin:copy": {
        const title = ws.pinStore.list().find((p) => p.id === id)?.text ?? label ?? id;
        await vscode.env.clipboard.writeText(`ID: ${id}\nTitle: ${title}`);
        notify(vscode.l10n.t("Pin copied: {0}", id));
        return;
      }
      case "pin:copyId": {
        await vscode.env.clipboard.writeText(id);
        notify(vscode.l10n.t("Pin ID copied: {0}", id));
        return;
      }
      case "pin:edit": return exec("tachyon.editPinItem", { ws, pinId: id });
      case "pin:delete": domainActions.deletePin(ws, id, { onChanged: () => this.refresh() }); return;
      case "schedule:pause": domainActions.toggleSchedulePause(ws, id, { onChanged: () => this.refresh() }); return;
      case "schedule:edit": return exec("tachyon.editScheduleStudioItem", { ws, scheduleName: id });
      case "schedule:editYaml": return exec("tachyon.editScheduleItem", { ws, scheduleName: id });
      case "schedule:delete": {
        const answer = await vscode.window.showWarningMessage(
          vscode.l10n.t("Delete schedule '{0}' from tachyon.yml?", id),
          { modal: true },
          vscode.l10n.t("Delete"),
        );
        if (answer === vscode.l10n.t("Delete")) domainActions.deleteSchedule(ws, id, { onChanged: () => this.refresh() });
        return;
      }
      case "proposal:approve": domainActions.approveProposal(ws, id, { onChanged: () => this.refresh() }); return;
      case "proposal:reject": {
        const answer = await vscode.window.showWarningMessage(
          vscode.l10n.t("Reject the proposed schedule '{0}'?", label ?? id),
          { modal: true },
          vscode.l10n.t("Reject"),
        );
        if (answer === vscode.l10n.t("Reject")) domainActions.rejectProposal(ws, id, { onChanged: () => this.refresh() });
        return;
      }
    }
  }

  private previewPin(ws: Workspace, id: string): void {
    try {
      const detail = ws.pinStore.readDetail(id);
      const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
      const blobRoot = vscode.Uri.file(new PinAttachmentStore(ws.workspaceRoot).blobDir);
      // spec 279 — scripts ON to load the preact bundle. SAFE because the bundle renders all pin content as
      // TEXT (preact escapes by default), never innerHTML, under a strict nonce'd CSP (the shell). Images load
      // only from host-resolved asWebviewUri blobs in blobRoot.
      const panel = vscode.window.createWebviewPanel(
        "tachyonPinPreview",
        `Pin Preview — ${id}`,
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        { enableScripts: true, localResourceRoots: [root, blobRoot] },
      );
      panel.iconPath = panelIcon(this.extensionUri, "eye"); // spec 282 — contextual editor-tab icon
      const preview: PinPreviewVM = {
        id,
        title: detail.summary.text,
        ...(detail.summary.by ? { by: detail.summary.by } : {}),
        done: detail.summary.done,
        tags: detail.summary.tags ?? [],
        body: pinDocPreview(detail.doc) || detail.summary.text,
        attachments: detail.attachments.map((att): PinPreviewAttachmentVM => {
          if (att.kind === "image") {
            return {
              id: att.id,
              kind: "image",
              name: att.name,
              available: att.available,
              ...(att.available ? { uri: panel.webview.asWebviewUri(vscode.Uri.file(path.join(ws.workspaceRoot, att.path))).toString() } : {}),
              detail: `${att.mediaType.replace(/^image\//, "").toUpperCase()} · ${Math.round(att.size / 1024)} KB`,
            };
          }
          return {
            id: att.id,
            kind: "excalidraw",
            name: att.name,
            available: att.previewAvailable,
            ...(att.previewAvailable ? { uri: panel.webview.asWebviewUri(vscode.Uri.file(path.join(ws.workspaceRoot, att.previewPath))).toString() } : {}),
            detail: `Sketch · ${att.elementCount} element${att.elementCount === 1 ? "" : "s"} · ${Math.round(att.previewSize / 1024)} KB preview`,
          };
        }),
      };
      const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
      panel.webview.html = renderWebviewShell({
        cspSource: panel.webview.cspSource,
        title: `Pin Preview — ${id}`,
        styles: [uri("codicon.css"), uri("design-system.css"), uri("pin-preview.css")],
        bundle: uri("pin-preview.js"),
        mode: "static",
        imgBlob: true,
      });
      // preact-static: post the VM once the bundle signals ready.
      panel.webview.onDidReceiveMessage((m: { type?: string } | undefined) => {
        if (m?.type === READY) void panel.webview.postMessage(pinPreviewMessage(preview));
      });
    } catch (err) {
      notify(vscode.l10n.t("Could not preview pin: {0}", err instanceof Error ? err.message : String(err)), "error");
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
    if (!ws) {
      console.log(`[tachyon] sidebar action ignored: workspace not found for hash=${wsHash ?? "<default>"}`);
      notify(vscode.l10n.t("Sidebar action ignored — workspace is no longer active"), "warn");
      return;
    }
    if (id === "inspect") { void vscode.commands.executeCommand("tachyon.openAgentTerminalItem", agent, ws.wsHash); return; }
    if (id === "activity") { void vscode.commands.executeCommand("tachyon.openAgentActivity", agent, ws.wsHash); return; } // spec 238
    if (id === "probes") { void vscode.commands.executeCommand("tachyon.openProbes", ws.wsHash, agent); return; } // spec 322 — this agent's probes only
    const fleet = this.lastFleets.find((f) => f.folder?.hash === ws.wsHash);
    const vm = fleet?.agents.find((x) => x.name === agent) ?? fleet?.terminals.find((x) => x.name === agent);
    const item = { ws, agentName: agent, contextValue: vm ? ctxOf(vm) : `agent-running` };
    void vscode.commands.executeCommand(ACTION_CMD[id], item).then(undefined, (err) => {
      console.log(`[tachyon] sidebar command failed id=${id} agent=${agent}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      notify(`${err instanceof Error ? err.message : String(err)}`, "error");
    });
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
    const evidenceOf = new Map<string, EvidenceBadge>();
    await Promise.all([...worktrees.keys()].map(async (name) => {
      const info = await ws.verifyInfo(name);
      if (info) verifyOf.set(name, info.badge === "verified" ? "pass" : info.badge === "failing" ? "fail" : "stale");
      const badge = evidenceBadge(await ws.evidenceHandoff(name)); // spec 273 — non-binary evidence indicator
      if (badge) evidenceOf.set(name, badge);
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
        evidence: evidenceOf.get(a.name),
        harness: !!ws.manager.defOf(a.name)?.harness,
        forkable: canFork(a.name, a.running, a.kind),
        forked: ws.ledger.get(a.name)?.def?.fork === true, // spec 225 — IS a forked sibling

        resumable: !a.running && resumable.has(a.name),
        freshStart: !a.running && resumable.has(a.name) && resumeReadyOf.get(a.name) === false,
        ai: true,
        adhoc: !a.declared,
        continuity: a.running ? ws.continuityBadge(a.name) : undefined, // spec 241 — badge only while running
        persistenceHooks: typeof ws.persistenceHookHealth === "function" ? ws.persistenceHookHealth(a.name) : undefined,
        canDismiss: !a.declared && !a.running,
      }));
    // Terminals are managed entries with ai:false → same model + action matrix, reduced set (no resume-context/
    // fork/verify/re-anchor). A stopped terminal thus gets ▶ Start; a running one Open/Restart/Kill.
    const terminals = all
      .filter((a) => a.kind === "terminal")
      .map((a) => {
        const vm = toAgentVM(a, { ai: false, adhoc: !a.declared, resumable: !a.running && resumable.has(a.name) });
        if (!a.declared && !a.running) vm.canDismiss = true;
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
    // spec 245 — the per-folder Project Handoff badge state (read-only snapshot; cheap).
    const hsnap = ws.handoffStore.snapshot(ws.lastActivityAt?.() ?? null);
    const handoff = { exists: hsnap.exists, staleness: hsnap.staleness, pendingCount: hsnap.pendingCount };
    const pins = ws.pinStore.list().map((p) => ({
      id: p.id,
      text: p.text,
      done: p.done,
      by: p.by,
      tags: p.tags ?? [],
      detail: p.detail,
      attachmentCount: p.attachmentCount,
    }));
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
    return { folder: { hash: ws.wsHash, name: ws.folderName }, bridge, agents, terminals, commands, runbooks, pins, schedules, pipelines, proposals, handoff };
  }
}

/** Map a pipeline node status to the sidebar dot color bucket. */
function nodeStatus(s: string): AgentStatus {
  return s === "running" ? "running" : s === "done" || s === "completed" ? "idle" : s === "failed" ? "crashed" : "stopped";
}

/** Reconstruct the contextValue the command handlers expect, from the agent VM's capability flags. */
function ctxOf(a: AgentVM): string {
  const state = a.status === "crashed" ? "crashed" : a.status === "stopped" ? "stopped" : "running";
  return agentContextValue({ state, ai: !!a.ai, adhoc: !!a.adhoc, worktree: !!a.worktree, verifiable: !!a.verifiable, forkable: !!a.forkable, harness: !!a.harness });
}

export function pinDocPreview(doc: TiptapJSON | null): string {
  if (!doc) return "";
  const blocks: string[] = [];
  collectPinDocText(doc, blocks);
  return blocks.map((line) => line.trim()).filter(Boolean).join("\n\n");
}

function collectPinDocText(node: TiptapJSON, blocks: string[]): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "listItem") {
    const text = inlinePinDocText(node).trim();
    if (text) blocks.push(`- ${text}`);
    return "";
  }
  const children = (node.content ?? []).map((child) => collectPinDocText(child, blocks)).join("");
  switch (node.type) {
    case "doc":
      return children;
    case "paragraph":
    case "heading":
    case "blockquote":
    case "codeBlock":
      if (children.trim()) blocks.push(children);
      return "";
    case "bulletList":
    case "orderedList":
      return children;
    case "tachyonSketch":
      blocks.push("[Sketch]");
      return "";
    case "image":
      blocks.push("[Image]");
      return "";
    case "hardBreak":
      return "\n";
    default:
      return children;
  }
}

function inlinePinDocText(node: TiptapJSON): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(inlinePinDocText).join("");
}
