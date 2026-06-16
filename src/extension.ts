import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs";
import { doctor, probeServer, recoverWedgedServer, snapshotServerPids, TmuxService, SESSION_PREFIX, SOCKET_NAME, type ServerProbe } from "./tmux/TmuxService.js";
import { watchdogStep, type WatchdogState } from "./tmux/wedgeWatchdog.js";
import { isResumable } from "./resume/SessionLedger.js";
import { subtreeCpuTicks } from "./attention/cpu.js";
import { classifySession } from "./inspector/classify.js";
import { CONFIG_FILENAMES, inferKind, type ScheduleDef } from "./config/loadConfig.js";
import { addAgent, cloneAgent, deleteAgent, agentEntryLine, deleteCommand, commandEntryLine, deleteRunbook, runbookEntryLine, scheduleEntryLine } from "./config/YamlConfigEditor.js";
import { openAgentStudio, type StudioSubmit } from "./webview/AgentForm.js";
import { openServerInspector } from "./webview/ServerInspector.js";
import { buildOffers, type RegistrationOffer } from "./registration/adapters.js";
import { executeWait, type BridgeDeps } from "./bridge/tools.js";
import {
  AgentsProvider,
  LayoutsProvider,
  PinsProvider,
  CommandsProvider,
  SchedulesProvider,
  TachyonProvider,
  type AgentTreeItem,
  type PinTreeItem,
  type CommandTreeItem,
  type RunbookTreeItem,
  type ScheduleTreeItem,
  type ProposalTreeItem,
} from "./presentation/Sidebar.js";
import { isAdhocItem } from "./presentation/contextValue.js";
import { Workspace, type ViewKind } from "./workspace/Workspace.js";
import type { WorktreeRecord } from "./worktree/WorktreeManager.js";
import { worktreeShowFile } from "./worktree/WorktreeManager.js";
import { emptySides, baseSidePath, diffTitle } from "./worktree/review.js";
import { probePrReadiness, composePrTitle, composePrBody, createWorktreePr, isWorktreeDirty } from "./worktree/pr.js";

/** spec 213 — URI scheme for the base side of a worktree diff (git show <ref>:<file>). */
const WT_DIFF_SCHEME = "tachyon-worktree";
import { notify } from "./workspace/notify.js";
import { FEATURES } from "./features.js";
import { detectInstalledClis } from "./webview/cliDetect.js";
import { buildStarterYaml, ensureTachyonGitignore, type DetectedProject } from "./init/initLogic.js";

/**
 * Thin shell over a REGISTRY of Workspaces (multi-root, F9): one Workspace per
 * folder carrying a tachyon.yml, created/disposed live as folders come and go.
 * Commands registered once, globally; each resolves its target folder from the
 * clicked item (`item.ws`), an explicit wsHash argument, or — for palette
 * commands with several folders active — a folder QuickPick.
 */

const registry = new Map<string, Workspace>(); // folder fsPath -> Workspace

function workspaces(): Workspace[] {
  return [...registry.values()];
}

function byHash(hash?: string): Workspace | undefined {
  if (hash) return workspaces().find((ws) => ws.wsHash === hash);
  const all = workspaces();
  return all.length === 1 ? all[0] : undefined;
}

/** Folder disambiguation: 0 folders → undefined+warn, 1 → it, N → QuickPick. */
async function pickWorkspace(): Promise<Workspace | undefined> {
  const all = workspaces();
  if (all.length === 0) {
    notify(vscode.l10n.t("no Tachyon workspace is active"), "warn");
    return undefined;
  }
  if (all.length === 1) return all[0];
  const picked = await vscode.window.showQuickPick(
    all.map((ws) => ({ label: ws.folderName, description: ws.bridgeUrl() ?? "", ws })),
    { placeHolder: vscode.l10n.t("Which folder?") },
  );
  return picked?.ws;
}

/** Resolves the target for arg-style commands: explicit hash beats the single default. */
function targetOf(hash?: string): Workspace | undefined {
  const ws = byHash(hash);
  if (!ws) notify(vscode.l10n.t("no Tachyon workspace is active"), "warn");
  return ws;
}

/**
 * Tree items carry their Workspace; integration tests and external automation
 * pass plain objects — those resolve to the single active workspace.
 */
function wsOf<T extends { ws?: Workspace }>(item: T): Workspace | undefined {
  const ws = item.ws ?? byHash(undefined);
  if (!ws) notify(vscode.l10n.t("no Tachyon workspace is active"), "warn");
  return ws;
}

/**
 * spec 210 — the kill/dismiss worktree cleanup. Blocked while a descendant session is
 * alive; otherwise shows path + dirty + ahead/unpushed + branch ownership, then removes
 * the worktree. The branch is auto-deleted ONLY when it's Tachyon-created AND safely
 * mergeable (git branch -d refuses unmerged work). A branch with unmerged commits — or any
 * pre-existing (human) branch — is KEPT and only force-deleted via a spelled-out 2nd
 * confirm, so committed-but-unmerged work is never lost in one click. Returns the outcome
 * so the caller knows whether to proceed with removing the agent itself.
 */
async function confirmAndRemoveWorktree(
  ws: Workspace,
  name: string,
  rec: WorktreeRecord,
): Promise<"removed" | "kept" | "blocked"> {
  const live = await ws.manager.liveDescendants(name);
  if (live.length > 0) {
    notify(vscode.l10n.t("Stop '{0}'s sub-agents first ({1}) — they share its worktree.", name, live.join(", ")), "warn");
    return "blocked";
  }
  const st = await ws.worktrees.status(rec.path, rec.baseRef);
  const dirty = st.staged + st.unstaged + st.untracked + st.conflicts;
  const lines = [
    vscode.l10n.t("Worktree: {0}", rec.path),
    rec.tachyonCreatedBranch
      ? vscode.l10n.t("Branch: {0} (created by Tachyon)", rec.branch)
      : vscode.l10n.t("Branch: {0} (pre-existing — will be kept)", rec.branch),
  ];
  if (dirty > 0) lines.push(vscode.l10n.t("⚠ {0} uncommitted change(s) will be lost", dirty));
  if (st.aheadOfBase > 0) lines.push(vscode.l10n.t("⚠ {0} commit(s) ahead of base, {1} unpushed — the branch is kept unless you confirm again", st.aheadOfBase, st.unpushed));
  // The branch is only auto-deleted when it's Tachyon-created AND safely mergeable (git
  // branch -d refuses unmerged work) — so the primary action just removes the worktree.
  const removeLabel = vscode.l10n.t("Remove worktree");
  const keepLabel = vscode.l10n.t("Keep worktree");
  const answer = await vscode.window.showWarningMessage(lines.join("\n"), { modal: true }, removeLabel, keepLabel);
  if (answer !== removeLabel) return "kept"; // dismiss/Esc OR explicit keep → destroy nothing
  // Never remove a worktree out from under the agent's own running process — stop it first,
  // and if the stop genuinely fails (session still present), abort rather than yank the cwd
  // (review fixes: removal used to run before the kill, and a failed kill was swallowed).
  if ((await ws.manager.agentStates()).has(name)) {
    try {
      await ws.manager.kill(name);
    } catch {
      /* may already be gone — re-check below */
    }
    if ((await ws.manager.agentStates()).has(name)) {
      notify(vscode.l10n.t("Could not stop '{0}' — its worktree was left intact.", name), "error");
      return "kept";
    }
  }
  const res = await ws.worktrees.remove(rec, true); // safe-deletes a merged Tachyon branch; keeps anything unmerged/human
  if (!res.removed) {
    notify(vscode.l10n.t("Worktree removal failed: {0}", res.error ?? ""), "error");
    return "kept";
  }
  ws.ledger.clearWorktree(name);
  if (res.branchDeleted) {
    notify(vscode.l10n.t("Removed worktree and merged branch '{0}'.", rec.branch), "info");
    return "removed";
  }
  // The branch was KEPT — either a pre-existing (human) branch, or a Tachyon branch with
  // UNMERGED commits (safe-delete refused). Offer a separate, spelled-out force-delete.
  const reason = rec.tachyonCreatedBranch
    ? vscode.l10n.t("Worktree removed. Branch '{0}' has unmerged commits and was kept — force-delete it and LOSE that work?", rec.branch)
    : vscode.l10n.t("Worktree removed. The pre-existing branch '{0}' was kept — delete it too? This is destructive.", rec.branch);
  const del = vscode.l10n.t("Force-delete '{0}'", rec.branch);
  const a2 = await vscode.window.showWarningMessage(reason, { modal: true }, del);
  if (a2 === del) {
    const ok = await ws.worktrees.deleteBranch(rec.branch);
    notify(ok ? vscode.l10n.t("Branch '{0}' deleted.", rec.branch) : vscode.l10n.t("Could not delete '{0}' (unmerged? checked out?).", rec.branch), ok ? "info" : "warn");
  }
  return "removed";
}

function hasConfig(folderPath: string): boolean {
  return CONFIG_FILENAMES.some((name) => fs.existsSync(path.join(folderPath, name)));
}

async function pickAgent(ws: Workspace, placeholder: string, runningOnly: boolean): Promise<string | undefined> {
  const agents = await ws.manager.list();
  const candidates = runningOnly ? agents.filter((a) => a.running) : agents;
  if (candidates.length === 0) {
    notify(runningOnly ? vscode.l10n.t("no agents running") : vscode.l10n.t("no agents declared or running"), "warn");
    return undefined;
  }
  return vscode.window.showQuickPick(
    candidates.map((a) => a.name),
    { placeHolder: placeholder },
  );
}

async function connectRuntime(ws: Workspace): Promise<void> {
  const url = ws.bridge.url;
  if (!url) {
    notify(vscode.l10n.t("Bridge is not running"), "error");
    return;
  }
  const readWorkspaceFile = (rel: string): string | undefined => {
    const p = path.join(ws.workspaceRoot, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;
  };
  let offers: RegistrationOffer[];
  try {
    offers = buildOffers(
      url,
      {
        claudeMcpJson: readWorkspaceFile(".mcp.json"),
        opencodeJson: readWorkspaceFile("opencode.json"),
        codexToml: readWorkspaceFile(".codex/config.toml"),
      },
      (ws.config?.settings.auth ?? true),
    );
  } catch (err) {
    notify(vscode.l10n.t("cannot build registration: {0}", err instanceof Error ? err.message : String(err)), "error");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    offers.map((o) => ({ label: o.title, detail: o.notes, offer: o })),
    { placeHolder: vscode.l10n.t("Which agent runtime should connect to the Bridge?") },
  );
  if (!picked) return;
  const offer = picked.offer;

  if (offer.file && offer.content !== undefined) {
    if (offer.upToDate) {
      notify(vscode.l10n.t("{0} already registers the Bridge at {1} — nothing to do", offer.file, url));
      return;
    }
    // Idempotent merge: only the 'tachyon' key is (re)written; every other MCP
    // entry in a pre-existing file is preserved untouched.
    const target = path.join(ws.workspaceRoot, offer.file);
    fs.mkdirSync(path.dirname(target), { recursive: true }); // .codex/ may not exist yet
    fs.writeFileSync(target, offer.content, "utf8");
    notify(vscode.l10n.t("{0}: tachyon entry set to {1} — restart the agent runtime to pick it up", offer.file, url));
  } else {
    const doc = await vscode.workspace.openTextDocument({ content: offer.snippet, language: "plaintext" });
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.env.clipboard.writeText(offer.snippet);
    notify(vscode.l10n.t("{0}: snippet opened and copied to clipboard", offer.title));
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return;

  // Fail closed without tmux (or on native Windows) — actionable message, no half-spawned state.
  const health = await doctor();
  if (!health.ok) {
    void vscode.window.showErrorMessage(`Tachyon: ${health.message}`);
    return;
  }

  // A WEDGED server (zombie: holds the socket, fails every command) would turn
  // activation into an error storm with no obvious way out — offer the one-click
  // recovery up front. Healthy/cleanly-down probes return in one tmux call.
  const offerServerRecovery = async (pids: number[]): Promise<boolean> => {
    const recover = vscode.l10n.t("Recover");
    const pick = await vscode.window.showWarningMessage(
      `Tachyon: ${vscode.l10n.t("the tmux server on Tachyon's dedicated socket looks wedged — it holds the socket but fails every command. Recover now? (kills the stuck server; its sessions are already lost)")}`,
      recover,
    );
    if (pick !== recover) return false;
    await recoverWedgedServer({ pids });
    notify(vscode.l10n.t("tmux server recovered — the next start boots a fresh one."));
    return true;
  };
  const startupProbe = await probeServer();
  if (startupProbe.state === "wedged") await offerServerRecovery(startupProbe.pids);

  // spec 217 — background wedge watchdog. probeServer otherwise runs only at activation + two
  // manual commands, so a server that wedges mid-session (field incident 2026-06-14) is invisible
  // until reload. Poll on a low-frequency timer and AUTO-recover a TWO-tick-confirmed wedge (D-B:
  // a wedge already lost every session, so SIGKILLing the zombie loses nothing; the two-tick
  // confirm guards a transient WSL hiccup). ONE global watchdog — the dedicated socket is
  // process-global, not per-workspace.
  // SELF-RESCHEDULING (not setInterval) so ticks never overlap: probeServer uses execFile with no
  // timeout and the wedge IS a stuck-process class, so a slow probe under setInterval could complete
  // out of order and reorder observations (e.g. wedged→healthy→wedged arriving healthy→wedged→wedged),
  // faking the "two consecutive wedged" invariant and auto-SIGKILLing a healthy server (codex r2 MAJOR).
  // The next probe starts only after the current one (and any recovery) fully settles.
  let watchdog: WatchdogState = "idle";
  let watchdogDisposed = false;
  let watchdogTimer: ReturnType<typeof setTimeout>;
  const WATCHDOG_MS = 30_000;
  const tickWatchdog = async (): Promise<void> => {
    if (watchdogDisposed) return;
    try {
      let probe: ServerProbe;
      try {
        probe = await probeServer();
      } catch {
        // A probe error is not a wedge confirmation — feed "unknown" so it breaks a pending arm
        // (recovery needs two genuinely consecutive wedged ticks) without un-latching.
        watchdog = watchdogStep(watchdog, "unknown").next;
        return;
      }
      if (watchdogDisposed) return; // ignore a completion that landed after disposal
      const { next, action } = watchdogStep(watchdog, probe.state);
      watchdog = next;
      if (action === "recover" && probe.state === "wedged") {
        const snap = await snapshotServerPids(probe.pids);
        console.warn(`[tachyon] wedged tmux server auto-recovered. Server snapshot before SIGKILL:\n${snap}`);
        await recoverWedgedServer({ pids: probe.pids });
        notify(
          vscode.l10n.t("the tmux server was wedged — auto-recovered. Restart your agents to continue."),
          "warn",
        );
      }
    } finally {
      if (!watchdogDisposed) watchdogTimer = setTimeout(() => void tickWatchdog(), WATCHDOG_MS);
    }
  };
  watchdogTimer = setTimeout(() => void tickWatchdog(), WATCHDOG_MS);
  context.subscriptions.push({
    dispose: () => {
      watchdogDisposed = true;
      clearTimeout(watchdogTimer);
    },
  });

  const agentsView = new AgentsProvider(workspaces);
  const layoutsView = new LayoutsProvider(workspaces);
  const pinsView = new PinsProvider(workspaces);
  const commandsView = new CommandsProvider(workspaces);
  const schedulesView = new SchedulesProvider(workspaces);
  // Single unified tree: the four domain providers stay on as leaf routers; this
  // one owns the category spine and is what the view contributes.
  const tachyonView = new TachyonProvider(workspaces, {
    agents: agentsView,
    schedules: schedulesView,
    commands: commandsView,
    pins: pinsView,
  });
  let tachyonTree: vscode.TreeView<vscode.TreeItem> | undefined;
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

  // One tree → one badge: agents-need-input and schedule-proposals share it.
  const updateBadge = () => {
    if (!tachyonTree) return;
    const attention = workspaces().reduce((sum, ws) => sum + ws.monitor.needsInputCount(), 0);
    let proposals = 0;
    for (const ws of workspaces()) {
      try {
        proposals += ws.proposals.list().length;
      } catch {
        /* invalid pending json — ignore for the badge */
      }
    }
    const n = attention + proposals;
    const parts: string[] = [];
    if (attention > 0) parts.push(`${attention} agent(s) need your input`);
    if (proposals > 0) parts.push(`${proposals} schedule proposal(s) awaiting approval`);
    tachyonTree.badge = n > 0 ? { value: n, tooltip: parts.join(" · ") } : undefined;
  };
  const updateAttentionBadge = updateBadge;
  const updateStatusBar = () => {
    const all = workspaces();
    if (all.length === 0) {
      statusBar.hide();
      return;
    }
    const ports = all.map((ws) => ws.bridgeUrl()?.split(":")[2]?.replace("/mcp", "")).filter(Boolean);
    statusBar.text = all.length === 1 ? `$(zap) Tachyon :${ports[0] ?? "—"}` : `$(zap) Tachyon ×${all.length}`;
    statusBar.tooltip = all.map((ws) => `${ws.folderName} — ${ws.bridgeUrl() ?? vscode.l10n.t("not running")}`).join("\n");
    statusBar.command = "tachyon.copyBridgeUrl";
    statusBar.show();
  };

  const onViewsChanged = (view: ViewKind) => {
    if (view === "agents") {
      agentsView.refresh();
      updateAttentionBadge();
    } else if (view === "layouts") layoutsView.refresh();
    else if (view === "pins") pinsView.refresh();
    else if (view === "schedules") {
      schedulesView.refresh();
      updateScheduleBadge();
    } else commandsView.refresh();
  };
  const updateScheduleBadge = updateBadge;
  const refreshAll = () => {
    agentsView.refresh();
    layoutsView.refresh();
    pinsView.refresh();
    commandsView.refresh();
    schedulesView.refresh();
    updateAttentionBadge();
    updateScheduleBadge();
    updateStatusBar();
  };

  const addWorkspace = async (folderPath: string, autostart: boolean): Promise<Workspace> => {
    const ws = await Workspace.create(folderPath, { context, onViewsChanged });
    registry.set(folderPath, ws);
    if (autostart && hasConfig(folderPath)) {
      await ws.start();
      if (FEATURES.layouts) await ws.applyDefaultLayout();
    }
    refreshAll();
    return ws;
  };

  // Boot a folder on demand — used by creation commands so a fresh folder gets a
  // Workspace the moment the user ACTS (Init / New Agent / Studio), not just by
  // having the extension installed.
  const ensureWorkspaceFor = async (folderPath: string): Promise<Workspace> => {
    return registry.get(folderPath) ?? (await addWorkspace(folderPath, false));
  };

  // Picker for CREATION commands (New Agent / Studio tabs): unlike pickWorkspace
  // (which only sees booted workspaces), this offers every open folder and boots
  // the chosen one on demand — so creating something is itself the opt-in.
  const pickFolderForCreate = async (): Promise<Workspace | undefined> => {
    const open = vscode.workspace.workspaceFolders ?? [];
    if (open.length === 0) {
      notify(vscode.l10n.t("open a folder first"), "warn");
      return undefined;
    }
    let folder = open[0];
    if (open.length > 1) {
      const picked = await vscode.window.showQuickPick(
        open.map((f) => ({ label: f.name, description: f.uri.fsPath, f })),
        { placeHolder: vscode.l10n.t("Which folder?") },
      );
      if (!picked) return undefined;
      folder = picked.f;
    }
    return ensureWorkspaceFor(folder.uri.fsPath);
  };

  // LAZY ACTIVATION: only folders that already carry a tachyon.yml boot at startup
  // (Bridge, tmux engine, port). A folder you merely opened to look at stays inert
  // — its views show the "Initialize Tachyon" welcome instead. No surprise MCP
  // server, no tmux server, until you opt in.
  for (const folder of folders.filter((f) => hasConfig(f.uri.fsPath))) {
    await addWorkspace(folder.uri.fsPath, true);
  }

  // Folders added/removed live (multi-root): create with config, dispose on removal.
  const folderWatcher = vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
    for (const removed of e.removed) {
      const ws = registry.get(removed.uri.fsPath);
      if (ws) {
        registry.delete(removed.uri.fsPath);
        await ws.dispose(); // tmux sessions survive — reattach when the folder returns
      }
    }
    for (const added of e.added) {
      if (!registry.has(added.uri.fsPath) && hasConfig(added.uri.fsPath)) {
        await addWorkspace(added.uri.fsPath, true);
      }
    }
    refreshAll();
  });

  tachyonTree = vscode.window.createTreeView("tachyonTree", { treeDataProvider: tachyonView });
  tachyonTree.onDidChangeCheckboxState((e) => {
    for (const [item, checkboxState] of e.items) {
      const pin = item as PinTreeItem;
      const ws = wsOf(pin);
      if (!ws) continue;
      try {
        ws.pinStore.setDone(pin.pinId, checkboxState === vscode.TreeItemCheckboxState.Checked);
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }
    pinsView.refresh();
  });

  // spec 213 / C2 — serves the BASE side of a worktree diff (git show <ref>:<file>); the
  // current side is the on-disk file. `empty=1` yields "" (added base / deleted current).
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(WT_DIFF_SCHEME, {
      async provideTextDocumentContent(uri) {
        const q = new URLSearchParams(uri.query);
        if (q.get("empty")) return "";
        const cwd = q.get("cwd");
        const ref = q.get("ref");
        return cwd && ref ? worktreeShowFile(cwd, ref, uri.path.replace(/^\//, "")) : "";
      },
    }),
  );

  context.subscriptions.push(
    statusBar,
    folderWatcher,
    tachyonTree,
    ...(FEATURES.layouts ? [vscode.window.registerTreeDataProvider("tachyonLayouts", layoutsView)] : []),
    {
      dispose: () => {
        for (const ws of workspaces()) void ws.dispose();
        registry.clear();
      },
    },
    // ---- internal seams (integration tests; default to the single workspace) ----
    vscode.commands.registerCommand("tachyon._agents", (hash?: string) => byHash(hash)?.manager.list() ?? []),
    vscode.commands.registerCommand(
      "tachyon._spawn",
      (name: string, opts?: { cmd?: string; cwd?: string; instructions?: string; parent?: string }, hash?: string) =>
        byHash(hash)?.manager.spawn(name, opts),
    ),
    vscode.commands.registerCommand("tachyon._wait", (name: string, until: "idle" | "needs-input" | "dead", timeoutSec: number, hash?: string) => {
      const ws = byHash(hash);
      if (!ws) return { met: false, state: "gone" };
      return executeWait(
        { manager: ws.manager, attentionOf: (a) => ws.monitor.stateOf(a)?.state, waiters: ws.waiters } as Pick<BridgeDeps, "manager" | "attentionOf" | "waiters">,
        name,
        until,
        timeoutSec,
      );
    }),
    vscode.commands.registerCommand("tachyon._attention", (hash?: string) => {
      const out: Record<string, { state: string; matchedLine?: string }> = {};
      for (const [agent, att] of byHash(hash)?.monitor.states() ?? new Map()) {
        out[agent] = { state: att.state, matchedLine: att.matchedLine };
      }
      return out;
    }),
    vscode.commands.registerCommand("tachyon._pins", (hash?: string) => byHash(hash)?.pinStore.list() ?? []),
    vscode.commands.registerCommand("tachyon._pin", (text: string, by?: string, done?: boolean, hash?: string) => {
      const ws = byHash(hash);
      if (!ws) return;
      const pin = ws.pinStore.create(text, by ?? "claude");
      if (done) ws.pinStore.setDone(pin.id, true);
      refreshAll();
    }),
    vscode.commands.registerCommand("tachyon._upsertAgent", (submit: StudioSubmit, hash?: string) => byHash(hash)?.studioSubmit(submit)),
    vscode.commands.registerCommand("tachyon._runCommand", (name: string, hash?: string) => byHash(hash)?.commandRunner.run(name)),
    vscode.commands.registerCommand("tachyon._commands", (hash?: string) => byHash(hash)?.commandRunner.list() ?? []),
    vscode.commands.registerCommand("tachyon._commandTick", (hash?: string) => byHash(hash)?.commandRunner.tick()),
    vscode.commands.registerCommand("tachyon._runRunbook", (name: string, hash?: string) => byHash(hash)?.runbookRunner.run(name)),
    vscode.commands.registerCommand("tachyon._runbooks", (hash?: string) => byHash(hash)?.runbookRunner.list() ?? []),
    vscode.commands.registerCommand("tachyon._schedules", (hash?: string) => byHash(hash)?.scheduler.list() ?? []),
    vscode.commands.registerCommand("tachyon._proposals", (hash?: string) => byHash(hash)?.proposals.list() ?? []),
    vscode.commands.registerCommand("tachyon._propose", (name: string, schedule: ScheduleDef, reason?: string, hash?: string) => {
      byHash(hash)?.proposals.create(name, schedule, "agent", reason);
      refreshAll();
    }),
    vscode.commands.registerCommand("tachyon._approveProposal", (id: string, hash?: string) => byHash(hash)?.approveProposal(id)),
    vscode.commands.registerCommand("tachyon._rejectProposal", (id: string, hash?: string) => byHash(hash)?.rejectProposal(id)),
    // ---- schedules (F23) ----
    vscode.commands.registerCommand("tachyon.approveProposalItem", (item: ProposalTreeItem) => {
      const ws = wsOf(item);
      if (ws) ws.approveProposal(item.proposalId);
    }),
    vscode.commands.registerCommand("tachyon.rejectProposalItem", async (item: ProposalTreeItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t("Reject the proposed schedule '{0}'?", item.label as string),
        { modal: true },
        vscode.l10n.t("Reject"),
      );
      if (answer === vscode.l10n.t("Reject")) ws.rejectProposal(item.proposalId);
    }),
    vscode.commands.registerCommand("tachyon.toggleSchedulePauseItem", (item: ScheduleTreeItem) => {
      const ws = wsOf(item);
      if (ws) ws.toggleSchedulePause(item.scheduleName);
    }),
    // Distinct inline action for a paused schedule (▶ resume) — same toggle underneath;
    // the menu's contextValue gating guarantees this only shows when paused.
    vscode.commands.registerCommand("tachyon.resumeScheduleItem", (item: ScheduleTreeItem) => {
      const ws = wsOf(item);
      if (ws) ws.toggleSchedulePause(item.scheduleName);
    }),
    vscode.commands.registerCommand("tachyon._togglePause", (name: string, hash?: string) => byHash(hash)?.toggleSchedulePause(name)),
    vscode.commands.registerCommand("tachyon.deleteScheduleItem", async (item: ScheduleTreeItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t("Delete schedule '{0}' from tachyon.yml?", item.scheduleName),
        { modal: true },
        vscode.l10n.t("Delete"),
      );
      if (answer === vscode.l10n.t("Delete")) ws.deleteScheduleEntry(item.scheduleName);
    }),
    vscode.commands.registerCommand("tachyon.editScheduleItem", async (item: ScheduleTreeItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const file = ws.configPath();
      if (!file) {
        notify(vscode.l10n.t("no tachyon.yml in this workspace"), "warn");
        return;
      }
      const doc = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const line = scheduleEntryLine(doc.getText(), item.scheduleName);
      if (line !== undefined) {
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }),
    vscode.commands.registerCommand("tachyon._workspaces", () => workspaces().map((ws) => ({ folder: ws.folderName, root: ws.workspaceRoot, hash: ws.wsHash, bridge: ws.bridgeUrl() }))),
    // ---- views ----
    vscode.commands.registerCommand("tachyon.refreshViews", refreshAll),
    // ---- onboarding (F24) ----
    vscode.commands.registerCommand("tachyon.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:cfpperche.tachyon"),
    ),
    // ---- server inspector (F27) — cross-workspace, standalone socket queries ----
    vscode.commands.registerCommand("tachyon.inspectServer", () => {
      const svc = new TmuxService();
      const folderByHash = () => new Map(workspaces().map((ws) => [ws.wsHash, ws.folderName]));
      // CPU busy/idle is a rate, so we keep the previous tick sample per pid across
      // refreshes and compare. Linux-only (subtreeCpuTicks returns null elsewhere).
      const prevCpu = new Map<number, { ticks: number; at: number }>();
      const cpuBusy = (rows: { pid: number; dead: boolean; session: string }[]) => {
        const now = Date.now();
        const out = new Map<string, boolean>();
        const seen = new Set<number>();
        for (const r of rows) {
          if (r.dead || r.pid <= 0) continue;
          const ticks = subtreeCpuTicks(r.pid);
          if (ticks === null) continue;
          seen.add(r.pid);
          const prev = prevCpu.get(r.pid);
          prevCpu.set(r.pid, { ticks, at: now });
          if (!prev) continue; // first sample — no rate yet
          const dt = (now - prev.at) / 1000;
          if (dt <= 0) continue;
          const rate = (ticks - prev.ticks) / dt; // ticks/sec (~100 = one full core)
          out.set(r.session, rate > 3);
        }
        for (const pid of [...prevCpu.keys()]) if (!seen.has(pid)) prevCpu.delete(pid);
        return out;
      };
      // Open: attach the session in a transient editor terminal, deduped by session.
      const termBySession = new Map<string, vscode.Terminal>();
      const openSession = (session: string) => {
        const existing = termBySession.get(session);
        if (existing) {
          existing.show(false);
          void svc.refreshClients(session);
          return;
        }
        const terminal = vscode.window.createTerminal({
          name: `⚡ ${session}`,
          location: { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
          shellPath: "tmux",
          shellArgs: ["-L", SOCKET_NAME, "attach-session", "-d", "-t", `=${session}`],
          isTransient: true,
        });
        termBySession.set(session, terminal);
        terminal.show(true);
      };
      context.subscriptions.push(
        vscode.window.onDidCloseTerminal((t) => {
          for (const [s, term] of termBySession) if (term === t) termBySession.delete(s);
        }),
      );
      const reap = async (label: string, targets: string[]) => {
        if (targets.length === 0) return 0;
        const ok = await vscode.window.showWarningMessage(
          vscode.l10n.t("Kill {0} {1} session(s)? This cannot be undone.", targets.length, label),
          { modal: true },
          vscode.l10n.t("Kill"),
        );
        if (!ok) return 0;
        for (const s of targets) {
          try {
            await svc.killSession(s);
          } catch {
            /* already gone */
          }
        }
        return targets.length;
      };
      return openServerInspector({
        extensionUri: context.extensionUri,
        snapshot: () => svc.serverSnapshot(SESSION_PREFIX),
        folderByHash,
        cpuBusy,
        capture: (session) => svc.capturePane(session, 200),
        open: openSession,
        kill: (session) => svc.killSession(session),
        reapDead: async () => {
          const snap = await svc.serverSnapshot(SESSION_PREFIX);
          return reap(vscode.l10n.t("dead"), snap.filter((r) => r.dead).map((r) => r.session));
        },
        reapOrphans: async () => {
          const snap = await svc.serverSnapshot(SESSION_PREFIX);
          const open = folderByHash();
          const targets = snap
            .filter((r) => {
              const h = classifySession(r.session).wsHash;
              return h !== undefined && !open.has(h);
            })
            .map((r) => r.session);
          return reap(vscode.l10n.t("orphaned"), targets);
        },
      });
    }),
    vscode.commands.registerCommand("tachyon.getStarted", () =>
      vscode.commands.executeCommand("workbench.action.openWalkthrough", "cfpperche.tachyon#tachyon.welcome", false),
    ),
    vscode.commands.registerCommand("tachyon.checkRequirements", async () => {
      const r = await doctor();
      if (r.ok) {
        const probe = await probeServer();
        if (probe.state === "wedged") {
          void offerServerRecovery(probe.pids);
          return;
        }
        notify(vscode.l10n.t("Requirements OK — tmux {0} detected.", r.version));
      } else {
        void vscode.window
          .showWarningMessage(`Tachyon: ${r.message}`, vscode.l10n.t("tmux install docs"))
          .then((c) => {
            if (c === vscode.l10n.t("tmux install docs")) void vscode.env.openExternal(vscode.Uri.parse("https://github.com/tmux/tmux/wiki/Installing"));
          });
      }
    }),
    vscode.commands.registerCommand("tachyon.restartTmuxServer", async () => {
      const probe = await probeServer();
      if (probe.state === "wedged") {
        await offerServerRecovery(probe.pids);
        return;
      }
      if (probe.state === "no-server") {
        notify(vscode.l10n.t("no tmux server running — nothing to recover."));
        return;
      }
      notify(vscode.l10n.t("tmux server is healthy — nothing to recover."));
    }),
    // ---- init / bootstrap (F5) ----
    vscode.commands.registerCommand("tachyon.init", async () => {
      const open = vscode.workspace.workspaceFolders ?? [];
      if (open.length === 0) {
        notify(vscode.l10n.t("open a folder first, then run Tachyon: Init"), "warn");
        return;
      }
      let folder = open[0];
      if (open.length > 1) {
        const picked = await vscode.window.showQuickPick(
          open.map((f) => ({ label: f.name, description: f.uri.fsPath, f })),
          { placeHolder: vscode.l10n.t("Initialize Tachyon in which folder?") },
        );
        if (!picked) return;
        folder = picked.f;
      }
      const root = folder.uri.fsPath;
      if (hasConfig(root)) {
        // Don't block the command on the user's click (it would hang headless) —
        // offer "Open it" as a fire-and-forget follow-up.
        void vscode.window
          .showInformationMessage(vscode.l10n.t("'{0}' already has a tachyon.yml.", folder.name), vscode.l10n.t("Open it"))
          .then(async (choice) => {
            if (choice === vscode.l10n.t("Open it")) {
              const existing = CONFIG_FILENAMES.map((n) => path.join(root, n)).find((p) => fs.existsSync(p))!;
              await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(existing), { preview: false });
            }
          });
        return;
      }
      // Detect the stack from manifests present (the only I/O — generation is pure).
      const manifests = ["package.json", "composer.json", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt", "Gemfile"];
      const files = manifests.filter((m) => fs.existsSync(path.join(root, m)));
      const readText = (n: string): string | undefined => {
        const p = path.join(root, n);
        return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;
      };
      const detected: DetectedProject = { files, installedClis: await detectInstalledClis() };
      const pkgRaw = readText("package.json");
      if (pkgRaw) {
        try {
          detected.packageJson = JSON.parse(pkgRaw);
        } catch {
          /* malformed package.json — generate without script hints */
        }
      }
      detected.composerJson = readText("composer.json");
      detected.gemfile = readText("Gemfile");

      const target = path.join(root, "tachyon.yml");
      try {
        fs.writeFileSync(target, buildStarterYaml(detected), "utf8");
      } catch (err) {
        notify(vscode.l10n.t("could not write tachyon.yml: {0}", err instanceof Error ? err.message : String(err)), "error");
        return;
      }
      // Keep the machine-local resume ledger out of git (it carries session ids
      // + absolute cwd). Idempotent + non-fatal — notes.md/pins.json stay shareable.
      try {
        const gi = path.join(root, ".gitignore");
        const next = ensureTachyonGitignore(fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : undefined);
        if (next !== null) fs.writeFileSync(gi, next, "utf8");
      } catch {
        /* .gitignore is a courtesy, never block Init on it */
      }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), { preview: false });
      notify(vscode.l10n.t("tachyon.yml created — review it, then ▶ an agent in the sidebar (or reload to autostart)"));
      // Bring the folder under orchestration now (it wasn't a Workspace before).
      if (!registry.has(root)) await addWorkspace(root, true);
      refreshAll();
    }),
    // ---- pins ----
    vscode.commands.registerCommand("tachyon.addPin", async (arg?: unknown) => {
      // Invoked with preset text (programmatic), a category tree node (inline +),
      // or nothing (palette).
      const text = typeof arg === "string" ? arg : undefined;
      const node = arg && typeof arg === "object" ? (arg as { ws?: Workspace }) : undefined;
      const ws = node?.ws ?? (await pickWorkspace());
      if (!ws) return;
      const value =
        text ??
        (await vscode.window.showInputBox({
          prompt: vscode.l10n.t("Pin a finding to the project's shared checklist"),
          placeHolder: vscode.l10n.t("e.g. dev server logs a deprecation warning on boot — investigate"),
        }));
      if (!value || value.trim().length === 0) return;
      try {
        ws.pinStore.create(value, "human");
        pinsView.refresh();
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.deletePinItem", (item: PinTreeItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        ws.pinStore.remove(item.pinId);
        pinsView.refresh();
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.editPinItem", async (item: PinTreeItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const current = ws.pinStore.list().find((p) => p.id === item.pinId)?.text ?? "";
      const next = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Edit pin"), value: current });
      if (next === undefined || next.trim() === current.trim() || next.trim().length === 0) return;
      try {
        ws.pinStore.update(item.pinId, next);
        pinsView.refresh();
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.openNotes", async (arg?: unknown) => {
      // Invoked with a workspace hash (Notes item), a category tree node (inline
      // notebook icon), or nothing (palette).
      const hash = typeof arg === "string" ? arg : undefined;
      const node = arg && typeof arg === "object" ? (arg as { ws?: Workspace }) : undefined;
      const ws = node?.ws ?? byHash(hash) ?? (await pickWorkspace());
      if (!ws) return;
      const file = ws.pinStore.ensureNotesFile();
      const doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    // ---- agents ----
    vscode.commands.registerCommand("tachyon.spawnAgentItem", async (item: AgentTreeItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        await ws.manager.spawn(item.agentName);
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.killAgentItem", async (item: AgentTreeItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        await ws.manager.kill(item.agentName);
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.restartAgentItem", async (item: AgentTreeItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        ws.lifecycle.resetBackoff(item.agentName); // human took over — clear crash-loop history
        await ws.manager.restart(item.agentName);
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.openAgentTerminalItem", (agent: string, hash?: string) => {
      const ws = targetOf(hash);
      if (ws) ws.terminals.open(agent, ws.manager.session(agent));
    }),
    // ---- session resume (F29 / spec 209) ----
    vscode.commands.registerCommand("tachyon.resumeAgentItem", async (item: AgentTreeItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        ws.lifecycle.resetBackoff(item.agentName);
        await ws.resumeAgent(item.agentName);
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    // ---- session fork (spec 225) ----
    vscode.commands.registerCommand("tachyon.forkAgentItem", async (item: AgentTreeItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        // Fail-closed plan first (resolves the live uuid; throws if not forkable yet) — then confirm.
        const plan = await ws.manager.planFork(item.agentName);
        const lines = [
          vscode.l10n.t("Fork '{0}' into a new sibling agent '{1}'?", item.agentName, plan.forkName),
          vscode.l10n.t("The fork carries the conversation up to now; the original keeps running, untouched."),
        ];
        if (plan.sourceWorktree) lines.push(vscode.l10n.t("It gets its own worktree, branched off '{0}' (committed work only).", plan.sourceWorktree.branch));
        if (plan.dirty) lines.push(vscode.l10n.t("⚠ Uncommitted changes in the original are NOT carried into the fork."));
        const forkLabel = vscode.l10n.t("Fork");
        const answer = await vscode.window.showWarningMessage(lines.join("\n"), { modal: true }, forkLabel);
        if (answer !== forkLabel) return;
        const created = await ws.manager.commitFork(plan);
        notify(vscode.l10n.t("Forked '{0}' → '{1}'", item.agentName, created));
        agentsView.refresh();
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "warn");
      }
    }),
    vscode.commands.registerCommand("tachyon.resumeAll", async () => {
      const targets = workspaces().filter((ws) => ws.resumableAgents().length > 0);
      if (targets.length === 0) {
        notify(vscode.l10n.t("no agents to resume"));
        return;
      }
      for (const ws of targets) await ws.resumeAllOffered();
    }),
    vscode.commands.registerCommand("tachyon.agentStudio", async () => {
      const ws = await pickFolderForCreate();
      if (!ws) return;
      ws.reloadConfig();
      await openAgentStudio(ws.studioDeps());
    }),
    vscode.commands.registerCommand("tachyon.terminalStudio", async () => {
      const ws = await pickFolderForCreate();
      if (!ws) return;
      ws.reloadConfig();
      await openAgentStudio(ws.studioDeps(), undefined, "terminal");
    }),
    vscode.commands.registerCommand("tachyon.runbookStudio", async () => {
      const ws = await pickFolderForCreate();
      if (!ws) return;
      ws.reloadConfig();
      await openAgentStudio(ws.studioDeps(), undefined, "runbook");
    }),
    vscode.commands.registerCommand("tachyon.editAgentStudioItem", async (item: AgentTreeItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      ws.reloadConfig();
      const def = ws.config?.agents[item.agentName];
      if (!def) {
        notify(vscode.l10n.t("'{0}' is not declared in tachyon.yml (ad-hoc agents have no stored definition)", item.agentName), "warn");
        return;
      }
      await openAgentStudio(ws.studioDeps(), { name: item.agentName, def });
    }),
    vscode.commands.registerCommand("tachyon.newAgent", async (name?: string, cmd?: string, kindArg?: "agent" | "terminal") => {
      const ws = await pickFolderForCreate();
      if (!ws) return;
      const agentName =
        name ??
        (await vscode.window.showInputBox({
          prompt: vscode.l10n.t("Agent name (a free label — e.g. frontend, reviewer, dev)"),
          validateInput: (v) => (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(v) ? undefined : vscode.l10n.t("letters/digits/_/-, starting with a letter")),
        }));
      if (!agentName) return;
      const agentCmd =
        cmd ??
        (await vscode.window.showInputBox({
          prompt: vscode.l10n.t("Command for '{0}' (what actually runs)", agentName),
          placeHolder: vscode.l10n.t("e.g. claude · codex · npm run dev"),
        }));
      if (!agentCmd) return;
      let kind = kindArg;
      if (!kind && name === undefined) {
        // Interactive flow: confirm the inferred kind (drives grouping + attention defaults).
        const inferred = inferKind(agentCmd);
        const picked = await vscode.window.showQuickPick(
          [
            { label: vscode.l10n.t("Agent"), description: vscode.l10n.t("AI CLI — attention detection on"), value: "agent" },
            { label: vscode.l10n.t("Terminal"), description: vscode.l10n.t("server / shell / build — attention off"), value: "terminal" },
          ].sort((a) => (a.value === inferred ? -1 : 1)),
          { placeHolder: vscode.l10n.t("Kind of '{0}' (detected: {1})", agentName, inferred) },
        );
        if (!picked) return;
        kind = picked.value as "agent" | "terminal";
      }
      const finalKind = kind && kind !== inferKind(agentCmd) ? kind : undefined; // write only when it differs from inference
      if (ws.mutateConfig((text) => addAgent(text, agentName, agentCmd, finalKind), () => agentsView.refresh())) {
        notify(vscode.l10n.t("'{0}' added — ▶ in the sidebar starts it", agentName));
      }
    }),
    vscode.commands.registerCommand("tachyon.cloneAgentItem", async (item: AgentTreeItem, newNameArg?: string) => {
      const ws = wsOf(item);
      if (!ws) return;
      const newName =
        newNameArg ??
        (await vscode.window.showInputBox({
          prompt: vscode.l10n.t("Clone '{0}' as…", item.agentName),
          value: `${item.agentName}-2`,
          validateInput: (v) => (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(v) ? undefined : vscode.l10n.t("letters/digits/_/-, starting with a letter")),
        }));
      if (!newName) return;
      ws.mutateConfig((text) => cloneAgent(text ?? "", item.agentName, newName), () => agentsView.refresh());
    }),
    vscode.commands.registerCommand("tachyon.renameAgentItem", async (item: AgentTreeItem, newNameArg?: string) => {
      const ws = wsOf(item);
      if (!ws) return;
      const newName =
        newNameArg ??
        (await vscode.window.showInputBox({
          prompt: vscode.l10n.t("Rename '{0}' to…", item.agentName),
          value: item.agentName,
          validateInput: (v) => (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(v) ? undefined : vscode.l10n.t("letters/digits/_/-, starting with a letter")),
        }));
      if (!newName || newName === item.agentName) return;
      try {
        // Works on running agents too: the tmux session is renamed in place and
        // every name-keyed subsystem follows (Workspace.renameAgent).
        await ws.renameAgent(item.agentName, newName);
        agentsView.refresh();
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.deleteAgentItem", async (item: AgentTreeItem, forceArg?: boolean) => {
      const ws = wsOf(item);
      if (!ws) return;
      const adhoc = isAdhocItem(item.contextValue);
      const states = await ws.manager.agentStates();
      const hasSession = states.has(item.agentName);
      let sessionKilled = false;
      const wtRec = ws.ledger.get(item.agentName)?.worktree;
      if (wtRec) {
        // spec 210 — a worktree agent's confirmation IS the worktree-cleanup modal.
        if (forceArg) {
          if ((await ws.manager.liveDescendants(item.agentName)).length === 0) {
            if (hasSession) {
              try {
                await ws.manager.kill(item.agentName); // stop before removing the cwd it runs in
              } catch {
                /* may already be gone — re-check */
              }
              sessionKilled = true;
            }
            // only remove if the session is genuinely gone (don't yank a still-running cwd)
            if (!(await ws.manager.agentStates()).has(item.agentName)) {
              const r = await ws.worktrees.remove(wtRec, true);
              if (r.removed) ws.ledger.clearWorktree(item.agentName);
            }
          }
        } else {
          const outcome = await confirmAndRemoveWorktree(ws, item.agentName, wtRec);
          if (outcome === "blocked") return;
          if (outcome === "kept") {
            // Decision 3 decline: destroy nothing; the agent just transitions to stopped.
            if (hasSession) {
              try {
                await ws.manager.kill(item.agentName);
              } catch (err) {
                notify(`${err instanceof Error ? err.message : String(err)}`, "error");
              }
            }
            return;
          }
          sessionKilled = true; // confirmAndRemoveWorktree stopped the session before removing the worktree
        }
      } else if (!forceArg) {
        const sessionNote = hasSession ? vscode.l10n.t(" Its tmux session will be killed too.") : "";
        const prompt = adhoc
          ? vscode.l10n.t("Dismiss ad-hoc agent '{0}'?", item.agentName) + sessionNote
          : vscode.l10n.t("Delete agent '{0}' from tachyon.yml?", item.agentName) + sessionNote;
        const confirmLabel = adhoc ? vscode.l10n.t("Dismiss") : vscode.l10n.t("Delete");
        const answer = await vscode.window.showWarningMessage(prompt, { modal: true }, confirmLabel);
        if (answer !== confirmLabel) return;
      }
      if (hasSession && !sessionKilled) {
        try {
          await ws.manager.kill(item.agentName);
        } catch (err) {
          notify(`${err instanceof Error ? err.message : String(err)}`, "error");
        }
      }
      if (adhoc) {
        // Ad-hoc agents aren't in tachyon.yml — forget the def, lineage and the
        // persisted ledger row so a sessionless/finished one stops rehydrating.
        ws.manager.dismissAdhoc(item.agentName);
        agentsView.refresh();
      } else {
        ws.mutateConfig((text) => deleteAgent(text ?? "", item.agentName), () => agentsView.refresh());
      }
    }),
    vscode.commands.registerCommand("tachyon.removeWorktreeItem", async (item: AgentTreeItem) => {
      // spec 210 — standalone "Remove worktree" (Decision 3): clean up the worktree while
      // keeping the agent entry. Same descendant guard + ownership-aware confirmation.
      const ws = wsOf(item);
      if (!ws) return;
      const rec = ws.ledger.get(item.agentName)?.worktree;
      if (!rec) {
        notify(vscode.l10n.t("'{0}' has no worktree", item.agentName), "warn");
        return;
      }
      await confirmAndRemoveWorktree(ws, item.agentName, rec);
      agentsView.refresh();
    }),
    vscode.commands.registerCommand("tachyon.reviewWorktreeItem", async (item: AgentTreeItem) => {
      // spec 213 / C2 — review the agent's work: a quick-pick of changed files (base ↔ current),
      // each opening VS Code's native diff editor. Reads the persisted worktree record (210).
      const ws = wsOf(item);
      if (!ws) return;
      const rec = ws.ledger.get(item.agentName)?.worktree;
      if (!rec) {
        notify(vscode.l10n.t("'{0}' has no worktree", item.agentName), "warn");
        return;
      }
      const changes = await ws.worktrees.changedFiles(rec.path, rec.baseRef);
      if (changes.length === 0) {
        notify(vscode.l10n.t("Nothing to review — '{0}'s worktree has no changes since it was created.", item.agentName), "info");
        return;
      }
      const glyph: Record<string, string> = { A: "$(diff-added)", M: "$(diff-modified)", D: "$(diff-removed)", R: "$(diff-renamed)", C: "$(diff-renamed)" };
      const pick = await vscode.window.showQuickPick(
        changes.map((c) => ({ label: `${glyph[c.status] ?? ""} ${c.from && c.from !== c.path ? `${c.from} → ${c.path}` : c.path}`, file: c })),
        {
          title: vscode.l10n.t("Review '{0}' — {1} changed file(s)", item.agentName, changes.length),
          placeHolder: vscode.l10n.t("Open a file's diff (base ↔ worktree)"),
        },
      );
      if (!pick) return;
      const f = pick.file;
      const { baseEmpty, currentEmpty } = emptySides(f.status);
      const emptyUri = vscode.Uri.from({ scheme: WT_DIFF_SCHEME, path: "/empty", query: "empty=1" });
      const base = baseEmpty
        ? emptyUri
        : vscode.Uri.from({ scheme: WT_DIFF_SCHEME, path: `/${baseSidePath(f)}`, query: `cwd=${encodeURIComponent(rec.path)}&ref=${encodeURIComponent(rec.baseRef)}` });
      const current = currentEmpty ? emptyUri : vscode.Uri.file(path.join(rec.path, f.path));
      await vscode.commands.executeCommand("vscode.diff", base, current, diffTitle(f, rec.baseRef));
    }),
    vscode.commands.registerCommand("tachyon.verifyAgentItem", async (item: AgentTreeItem) => {
      // spec 214 / C3 — run the agent's declared verify-gate in its worktree, update the badge.
      // Advisory: a failure surfaces but never blocks. Errors (no worktree/verify) are notified.
      const ws = wsOf(item);
      if (!ws) return;
      try {
        await ws.runVerify(item.agentName);
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), "warn");
      }
      agentsView.refresh();
    }),
    vscode.commands.registerCommand("tachyon.createWorktreePrItem", async (item: AgentTreeItem) => {
      // spec 223 — open a GitHub PR from the worktree's branch, carrying the verify verdict into the
      // body. Human stays at the gate: readiness is probed at CLICK (no per-refresh gh spawn), then an
      // editable title + a modal body preview confirm before `gh pr create` fires.
      const ws = wsOf(item);
      if (!ws) return;
      const rec = ws.ledger.get(item.agentName)?.worktree;
      if (!rec) {
        notify(vscode.l10n.t("'{0}' has no worktree", item.agentName), "warn");
        return;
      }
      if (!fs.existsSync(rec.path)) {
        notify(vscode.l10n.t("'{0}'s worktree path no longer exists", item.agentName), "warn");
        return;
      }
      const readiness = await probePrReadiness(rec.path, true);
      if (!readiness.ready) {
        notify(vscode.l10n.t("Can't open a PR: {0}", readiness.reason ?? "not ready"), "warn");
        return;
      }
      try {
        // Base BRANCH: ONLY the one persisted at worktree-create (a true fork off a known branch). We
        // never GUESS it from the SHA — an attached/pre-223 worktree has no known base, so we let gh
        // default and say so in the confirm (honest > a confident wrong guess). Detect dirty too
        // (uncommitted changes are NOT pushed → would silently miss the PR).
        const base = rec.baseBranch ?? null;
        const [dirty, verifyInfo] = await Promise.all([isWorktreeDirty(rec.path), ws.verifyInfo(item.agentName)]);
        const body = composePrBody({
          branch: rec.branch,
          base: base ?? undefined,
          verify: verifyInfo ? { badge: verifyInfo.badge, command: verifyInfo.command } : undefined,
        });
        const title = await vscode.window.showInputBox({
          title: vscode.l10n.t("Create PR for '{0}'", item.agentName),
          prompt: vscode.l10n.t("PR title — the body carries the verify verdict"),
          value: composePrTitle(rec.branch),
        });
        if (!title) return; // cancelled / empty
        const meta = [
          base ? vscode.l10n.t("Base branch: {0}", base) : vscode.l10n.t("Base: gh's default — confirm on the PR page"),
          dirty ? vscode.l10n.t("⚠ Uncommitted changes won't be in the PR — commit them first.") : null,
        ].filter((l): l is string => l !== null);
        const ok = await vscode.window.showInformationMessage(
          vscode.l10n.t("Open a GitHub PR for branch '{0}'?", rec.branch),
          { modal: true, detail: `${meta.join("\n")}\n\n${title}\n\n${body}` },
          vscode.l10n.t("Create PR"),
        );
        if (!ok) return;
        const result = await createWorktreePr(rec, { title, body, base: base ?? undefined });
        if ("error" in result) {
          notify(vscode.l10n.t("PR failed: {0}", result.error), "error");
          return;
        }
        const open = await vscode.window.showInformationMessage(
          result.existing ? vscode.l10n.t("A PR already exists for '{0}'.", rec.branch) : vscode.l10n.t("PR opened for '{0}'.", rec.branch),
          vscode.l10n.t("Open PR"),
        );
        if (open) await vscode.env.openExternal(vscode.Uri.parse(result.url));
      } catch (err) {
        // The worktree can vanish mid-flow (after the existsSync guard) → git/gh reject; surface it.
        notify(vscode.l10n.t("PR failed: {0}", err instanceof Error ? err.message : String(err)), "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.reanchorAgentItem", async (item: AgentTreeItem) => {
      // spec 216 — re-anchor the agent to its role: rewrite .tachyon/roles/<agent>.md + type a
      // reminder into the pane. Manual path (always on); the auto path is settings.anchor.auto.
      const ws = wsOf(item);
      if (!ws) return;
      try {
        await ws.reanchor(item.agentName);
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), "warn");
      }
    }),
    vscode.commands.registerCommand("tachyon.promoteAgentItem", async (item: AgentTreeItem) => {
      // Spec 211: promote an ad-hoc (MCP-spawned) agent to a declared one in
      // tachyon.yml. cmd + kind + instructions; never an absolute cwd (portability).
      const ws = wsOf(item);
      if (!ws) return;
      const name = item.agentName;
      const rec = ws.ledger.get(name);
      const def = rec?.def;
      if (!def) {
        notify(vscode.l10n.t("'{0}' has no stored definition to save.", name), "warn");
        return;
      }
      if (ws.config?.agents[name] !== undefined) {
        notify(vscode.l10n.t("'{0}' is already declared in tachyon.yml.", name), "warn");
        return;
      }
      const ok = ws.mutateConfig((text) => addAgent(text ?? "", name, def.cmd, def.kind, def.instructions), () => agentsView.refresh());
      if (!ok) return;
      // Transition the ledger: an adapter-backed agent keeps its row (flip to
      // declared, still resumable); a def-only row is removed (now it's in the yml).
      if (rec && isResumable(rec)) ws.ledger.record(name, { ...rec, declared: true });
      else ws.ledger.remove(name);
      ws.manager.forgetAdhoc(name); // config is now authoritative — drop the ad-hoc shadow
      agentsView.refresh();
      notify(vscode.l10n.t("'{0}' saved to tachyon.yml.", name));
    }),
    vscode.commands.registerCommand("tachyon.editAgentItem", async (item: AgentTreeItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const file = ws.configPath();
      if (!file) {
        notify(vscode.l10n.t("no tachyon.yml in this workspace"), "warn");
        return;
      }
      const doc = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const line = agentEntryLine(doc.getText(), item.agentName);
      if (line !== undefined) {
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }),
    // ---- lifecycle ----
    vscode.commands.registerCommand("tachyon.start", async () => {
      for (const ws of workspaces()) {
        await ws.start();
        if (FEATURES.layouts) await ws.applyDefaultLayout();
      }
      refreshAll();
    }),
    vscode.commands.registerCommand("tachyon.stopAll", async () => {
      let total = 0;
      for (const ws of workspaces()) {
        const killed = await ws.manager.killAll();
        await ws.commandRunner.killAll();
        await ws.runbookRunner.killAll();
        total += killed.length;
      }
      notify(total > 0 ? vscode.l10n.t("stopped {0} agent(s)", total) : vscode.l10n.t("no agents running"));
      refreshAll();
    }),
    vscode.commands.registerCommand("tachyon.restartAgent", async () => {
      const ws = await pickWorkspace();
      if (!ws) return;
      const agent = await pickAgent(ws, vscode.l10n.t("Restart which agent?"), false);
      if (!agent) return;
      try {
        await ws.manager.restart(agent);
        notify(vscode.l10n.t("'{0}' restarted", agent));
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.openAgentTerminal", async () => {
      const ws = await pickWorkspace();
      if (!ws) return;
      const agent = await pickAgent(ws, vscode.l10n.t("Open which agent's terminal?"), true);
      if (agent) ws.terminals.open(agent, ws.manager.session(agent));
    }),
    // ---- layouts ----
    vscode.commands.registerCommand("tachyon.applyLayout", async (layoutName?: string, hash?: string) => {
      const ws = byHash(hash) ?? (await pickWorkspace());
      if (!ws) return;
      ws.reloadConfig();
      const layouts = Object.entries(ws.config?.layouts ?? {});
      if (layouts.length === 0) {
        notify(vscode.l10n.t("no layouts declared in tachyon.yml"), "warn");
        return;
      }
      // Optional arg lets keybindings/automation apply a layout without the quick-pick.
      let name = layoutName;
      if (!name) {
        const picked = await vscode.window.showQuickPick(
          layouts.map(([n, def]) => ({ label: n, description: `${def.grid ?? "custom"} — ${def.agents.join(", ")}` })),
          { placeHolder: vscode.l10n.t("Apply which layout?") },
        );
        name = picked?.label;
      }
      if (!name) return;
      const def = ws.config?.layouts[name];
      if (!def) {
        notify(vscode.l10n.t("layout '{0}' is not declared in tachyon.yml", name), "warn");
        return;
      }
      await ws.applyLayoutWithSpawn(name, def);
    }),
    vscode.commands.registerCommand("tachyon.saveLayoutAs", async (name?: string, overwrite?: boolean) => {
      const ws = await pickWorkspace();
      return ws?.saveLayoutAs(name, overwrite);
    }),
    // ---- bridge ----
    vscode.commands.registerCommand("tachyon.copyBridgeToken", async () => {
      const ws = await pickWorkspace();
      if (!ws) return;
      if (!ws.token) {
        notify(vscode.l10n.t("Bridge auth is disabled (settings.auth: false) — no token"), "warn");
        return;
      }
      await vscode.env.clipboard.writeText(ws.token);
      notify(vscode.l10n.t("Bridge token copied — export it as TACHYON_BRIDGE_TOKEN for external agents"));
    }),
    vscode.commands.registerCommand("tachyon.copyBridgeUrl", async (hash?: string) => {
      const ws = byHash(hash) ?? (await pickWorkspace());
      if (!ws) return;
      if (!ws.bridge.url) {
        notify(vscode.l10n.t("Bridge is not running"), "error");
        return;
      }
      await vscode.env.clipboard.writeText(ws.bridge.url);
      notify(vscode.l10n.t("Bridge URL copied: {0}", ws.bridge.url));
    }),
    vscode.commands.registerCommand("tachyon.connectRuntime", async () => {
      const ws = await pickWorkspace();
      if (ws) await connectRuntime(ws);
    }),
    // ---- commands & runbooks ----
    vscode.commands.registerCommand("tachyon.runCommandItem", async (item: CommandTreeItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        await ws.commandRunner.run(item.commandName);
        commandsView.refresh();
        ws.openCommandPane(item.commandName);
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.openCommandTerminalItem", (name: string, hash?: string) => {
      targetOf(hash)?.openCommandPane(name);
    }),
    vscode.commands.registerCommand("tachyon.runRunbookItem", (item: RunbookTreeItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      // fire-and-forget: progress is observable in the tree; onFinished toasts
      void ws.runbookRunner.run(item.runbookName).catch((err) => {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      });
      setTimeout(() => commandsView.refresh(), 50); // pick up "running" promptly
    }),
    vscode.commands.registerCommand("tachyon.openRunbookStepItem", (runbook: string, index: number, hash?: string) => {
      targetOf(hash)?.openRunbookStepPane(runbook, index);
    }),
    vscode.commands.registerCommand("tachyon.editCommandItem", async (item: CommandTreeItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const file = ws.configPath();
      if (!file) {
        notify(vscode.l10n.t("no tachyon.yml in this workspace"), "warn");
        return;
      }
      const doc = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const line = commandEntryLine(doc.getText(), item.commandName);
      if (line !== undefined) {
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }),
    vscode.commands.registerCommand("tachyon.deleteCommandItem", async (item: CommandTreeItem, forceArg?: boolean) => {
      const ws = wsOf(item);
      if (!ws) return;
      if (!forceArg) {
        const answer = await vscode.window.showWarningMessage(
          vscode.l10n.t("Delete command '{0}' from tachyon.yml?", item.commandName),
          { modal: true },
          vscode.l10n.t("Delete"),
        );
        if (answer !== vscode.l10n.t("Delete")) return;
      }
      ws.mutateConfig((text) => deleteCommand(text ?? "", item.commandName), () => commandsView.refresh());
    }),
    vscode.commands.registerCommand("tachyon.editCommandStudioItem", async (item: CommandTreeItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      ws.reloadConfig();
      const def = ws.config?.commands[item.commandName];
      if (!def) {
        notify(vscode.l10n.t("'{0}' is not declared in tachyon.yml", item.commandName), "warn");
        return;
      }
      await openAgentStudio(ws.studioDeps(), { name: item.commandName, commandDef: def });
    }),
    vscode.commands.registerCommand("tachyon.commandStudio", async () => {
      const ws = await pickFolderForCreate();
      if (!ws) return;
      ws.reloadConfig();
      await openAgentStudio(ws.studioDeps(), undefined, "command");
    }),
    vscode.commands.registerCommand("tachyon.scheduleStudio", async () => {
      const ws = await pickFolderForCreate();
      if (!ws) return;
      ws.reloadConfig();
      await openAgentStudio(ws.studioDeps(), undefined, "schedule");
    }),
    vscode.commands.registerCommand("tachyon.editScheduleStudioItem", async (item: ScheduleTreeItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      ws.reloadConfig();
      const def = ws.config?.schedules[item.scheduleName];
      if (!def) {
        notify(vscode.l10n.t("'{0}' is not declared in tachyon.yml", item.scheduleName), "warn");
        return;
      }
      await openAgentStudio(ws.studioDeps(), { name: item.scheduleName, scheduleDef: def });
    }),
    vscode.commands.registerCommand("tachyon.editRunbookStudioItem", async (item: RunbookTreeItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      ws.reloadConfig();
      const def = ws.config?.runbooks[item.runbookName];
      if (!def) {
        notify(vscode.l10n.t("'{0}' is not declared in tachyon.yml", item.runbookName), "warn");
        return;
      }
      await openAgentStudio(ws.studioDeps(), { name: item.runbookName, runbookDef: def });
    }),
    vscode.commands.registerCommand("tachyon.editRunbookItem", async (item: RunbookTreeItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const file = ws.configPath();
      if (!file) {
        notify(vscode.l10n.t("no tachyon.yml in this workspace"), "warn");
        return;
      }
      const doc = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const line = runbookEntryLine(doc.getText(), item.runbookName);
      if (line !== undefined) {
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }),
    vscode.commands.registerCommand("tachyon.deleteRunbookItem", async (item: RunbookTreeItem, forceArg?: boolean) => {
      const ws = wsOf(item);
      if (!ws) return;
      if (ws.runbookRunner.isRunning(item.runbookName)) {
        notify(vscode.l10n.t("runbook '{0}' is running — wait for it to finish before deleting", item.runbookName), "warn");
        return;
      }
      if (!forceArg) {
        const answer = await vscode.window.showWarningMessage(
          vscode.l10n.t("Delete runbook '{0}' from tachyon.yml?", item.runbookName),
          { modal: true },
          vscode.l10n.t("Delete"),
        );
        if (answer !== vscode.l10n.t("Delete")) return;
      }
      ws.mutateConfig((text) => deleteRunbook(text ?? "", item.runbookName), () => commandsView.refresh());
    }),
  );

  updateStatusBar();
}

export function deactivate(): void {
  // tmux sessions intentionally survive — Tachyon re-attaches on next activation.
  for (const ws of registry.values()) void ws.dispose();
  registry.clear();
}
