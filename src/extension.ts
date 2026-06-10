import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs";
import { doctor } from "./tmux/TmuxService.js";
import { CONFIG_FILENAMES, inferKind } from "./config/loadConfig.js";
import { addAgent, cloneAgent, deleteAgent, renameAgent, agentEntryLine, deleteCommand, commandEntryLine, deleteRunbook, runbookEntryLine } from "./config/YamlConfigEditor.js";
import { openAgentStudio, type StudioSubmit } from "./webview/AgentForm.js";
import { buildOffers, type RegistrationOffer } from "./registration/adapters.js";
import { executeWait, type BridgeDeps } from "./bridge/tools.js";
import {
  AgentsProvider,
  LayoutsProvider,
  PinsProvider,
  CommandsProvider,
  type AgentTreeItem,
  type PinTreeItem,
  type CommandTreeItem,
  type RunbookTreeItem,
} from "./presentation/Sidebar.js";
import { Workspace } from "./workspace/Workspace.js";
import { notify } from "./workspace/notify.js";

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

  const agentsView = new AgentsProvider(workspaces);
  const layoutsView = new LayoutsProvider(workspaces);
  const pinsView = new PinsProvider(workspaces);
  const commandsView = new CommandsProvider(workspaces);
  let agentsTree: vscode.TreeView<vscode.TreeItem> | undefined;
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

  const updateAttentionBadge = () => {
    if (!agentsTree) return;
    const n = workspaces().reduce((sum, ws) => sum + ws.monitor.needsInputCount(), 0);
    agentsTree.badge = n > 0 ? { value: n, tooltip: `${n} agent(s) need your input` } : undefined;
  };
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

  const onViewsChanged = (view: "agents" | "layouts" | "pins" | "commands") => {
    if (view === "agents") {
      agentsView.refresh();
      updateAttentionBadge();
    } else if (view === "layouts") layoutsView.refresh();
    else if (view === "pins") pinsView.refresh();
    else commandsView.refresh();
  };
  const refreshAll = () => {
    agentsView.refresh();
    layoutsView.refresh();
    pinsView.refresh();
    commandsView.refresh();
    updateAttentionBadge();
    updateStatusBar();
  };

  const addWorkspace = async (folderPath: string, autostart: boolean): Promise<Workspace> => {
    const ws = await Workspace.create(folderPath, { context, onViewsChanged });
    registry.set(folderPath, ws);
    if (autostart && hasConfig(folderPath)) {
      await ws.start();
      await ws.applyDefaultLayout();
    }
    refreshAll();
    return ws;
  };

  // One Workspace per folder with a tachyon.yml; when none has one, the first
  // folder hosts Tachyon anyway (so "New Agent" can create the file there).
  const configured = folders.filter((f) => hasConfig(f.uri.fsPath));
  const initial = configured.length > 0 ? configured : [folders[0]];
  for (const folder of initial) {
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

  agentsTree = vscode.window.createTreeView("tachyonAgents", { treeDataProvider: agentsView });
  const pinsTree = vscode.window.createTreeView("tachyonPins", { treeDataProvider: pinsView });
  pinsTree.onDidChangeCheckboxState((e) => {
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

  context.subscriptions.push(
    statusBar,
    folderWatcher,
    agentsTree,
    pinsTree,
    vscode.window.registerTreeDataProvider("tachyonLayouts", layoutsView),
    vscode.window.registerTreeDataProvider("tachyonCommands", commandsView),
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
    vscode.commands.registerCommand("tachyon._upsertAgent", (submit: StudioSubmit, hash?: string) => byHash(hash)?.studioSubmit(submit)),
    vscode.commands.registerCommand("tachyon._runCommand", (name: string, hash?: string) => byHash(hash)?.commandRunner.run(name)),
    vscode.commands.registerCommand("tachyon._commands", (hash?: string) => byHash(hash)?.commandRunner.list() ?? []),
    vscode.commands.registerCommand("tachyon._commandTick", (hash?: string) => byHash(hash)?.commandRunner.tick()),
    vscode.commands.registerCommand("tachyon._runRunbook", (name: string, hash?: string) => byHash(hash)?.runbookRunner.run(name)),
    vscode.commands.registerCommand("tachyon._runbooks", (hash?: string) => byHash(hash)?.runbookRunner.list() ?? []),
    vscode.commands.registerCommand("tachyon._workspaces", () => workspaces().map((ws) => ({ folder: ws.folderName, root: ws.workspaceRoot, hash: ws.wsHash, bridge: ws.bridgeUrl() }))),
    // ---- views ----
    vscode.commands.registerCommand("tachyon.refreshViews", refreshAll),
    // ---- pins ----
    vscode.commands.registerCommand("tachyon.addPin", async (text?: string) => {
      const ws = await pickWorkspace();
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
    vscode.commands.registerCommand("tachyon.openNotes", async (hash?: string) => {
      const ws = byHash(hash) ?? (await pickWorkspace());
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
    vscode.commands.registerCommand("tachyon.agentStudio", async () => {
      const ws = await pickWorkspace();
      if (!ws) return;
      ws.reloadConfig();
      await openAgentStudio(ws.studioDeps());
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
      const ws = await pickWorkspace();
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
      const running = (await ws.manager.runningAgents()).includes(item.agentName);
      if (running) {
        notify(vscode.l10n.t("'{0}' is running — stop it before renaming (its session carries the old name)", item.agentName), "warn");
        return;
      }
      const newName =
        newNameArg ??
        (await vscode.window.showInputBox({
          prompt: vscode.l10n.t("Rename '{0}' to…", item.agentName),
          value: item.agentName,
          validateInput: (v) => (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(v) ? undefined : vscode.l10n.t("letters/digits/_/-, starting with a letter")),
        }));
      if (!newName || newName === item.agentName) return;
      ws.mutateConfig((text) => renameAgent(text ?? "", item.agentName, newName), () => agentsView.refresh());
    }),
    vscode.commands.registerCommand("tachyon.deleteAgentItem", async (item: AgentTreeItem, forceArg?: boolean) => {
      const ws = wsOf(item);
      if (!ws) return;
      const states = await ws.manager.agentStates();
      const hasSession = states.has(item.agentName);
      if (!forceArg) {
        const answer = await vscode.window.showWarningMessage(
          vscode.l10n.t("Delete agent '{0}' from tachyon.yml?", item.agentName) + (hasSession ? vscode.l10n.t(" Its tmux session will be killed too.") : ""),
          { modal: true },
          vscode.l10n.t("Delete"),
        );
        if (answer !== vscode.l10n.t("Delete")) return;
      }
      if (hasSession) {
        try {
          await ws.manager.kill(item.agentName);
        } catch (err) {
          notify(`${err instanceof Error ? err.message : String(err)}`, "error");
        }
      }
      ws.mutateConfig((text) => deleteAgent(text ?? "", item.agentName), () => agentsView.refresh());
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
        await ws.applyDefaultLayout();
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
      const ws = await pickWorkspace();
      if (!ws) return;
      ws.reloadConfig();
      await openAgentStudio(ws.studioDeps(), undefined, "command");
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
