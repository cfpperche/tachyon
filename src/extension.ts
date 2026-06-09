import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs";
import {
  TmuxService,
  doctor,
  workspaceHash,
  SESSION_PREFIX,
  agentFromSession,
} from "./tmux/TmuxService.js";
import { loadConfigFile, CONFIG_FILENAMES, type TachyonConfig } from "./config/loadConfig.js";
import { AgentManager, WatchController } from "./agents/AgentManager.js";
import { Terminals } from "./presentation/Terminals.js";
import { applyLayout } from "./presentation/Layouts.js";
import { Bridge } from "./bridge/Bridge.js";
import { buildOffers, type RegistrationOffer } from "./registration/adapters.js";
import type { NotifyLevel } from "./bridge/tools.js";
import { AgentsProvider, LayoutsProvider, type AgentTreeItem } from "./presentation/Sidebar.js";

interface TachyonState {
  workspaceRoot: string;
  wsHash: string;
  tmux: TmuxService;
  config?: TachyonConfig;
  manager: AgentManager;
  terminals: Terminals;
  bridge: Bridge;
  watches: WatchController;
  statusBar: vscode.StatusBarItem;
}

let state: TachyonState | undefined;

function notify(message: string, level: NotifyLevel = "info"): void {
  const show =
    level === "error"
      ? vscode.window.showErrorMessage
      : level === "warn"
        ? vscode.window.showWarningMessage
        : vscode.window.showInformationMessage;
  void show(`Tachyon: ${message}`);
}

function configPath(workspaceRoot: string): string | undefined {
  for (const name of CONFIG_FILENAMES) {
    const candidate = path.join(workspaceRoot, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function reloadConfig(s: TachyonState): boolean {
  const file = configPath(s.workspaceRoot);
  if (!file) {
    s.config = undefined;
    return false;
  }
  const { config, errors } = loadConfigFile(file);
  if (errors.length > 0) {
    notify(`invalid ${path.basename(file)} — ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`, "error");
    return false;
  }
  s.config = config;
  return true;
}

async function pickAgent(s: TachyonState, placeholder: string, runningOnly: boolean): Promise<string | undefined> {
  const agents = await s.manager.list();
  const candidates = runningOnly ? agents.filter((a) => a.running) : agents;
  if (candidates.length === 0) {
    notify(runningOnly ? "no agents running" : "no agents declared or running", "warn");
    return undefined;
  }
  return vscode.window.showQuickPick(
    candidates.map((a) => a.name),
    { placeHolder: placeholder },
  );
}

function rebuildWatches(s: TachyonState): void {
  s.watches.dispose();
  s.watches = new WatchController(async (agent) => {
    try {
      await s.manager.restart(agent);
      notify(`'${agent}' restarted (watched file changed)`);
    } catch (err) {
      notify(`watch-restart of '${agent}' failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  });
  for (const [name, def] of Object.entries(s.config?.agents ?? {})) {
    for (const glob of def.watch) {
      s.watches.watch(name, (onChange) => {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(s.workspaceRoot, glob),
        );
        watcher.onDidChange(onChange);
        watcher.onDidCreate(onChange);
        watcher.onDidDelete(onChange);
        return () => watcher.dispose();
      });
    }
  }
}

async function start(s: TachyonState): Promise<void> {
  if (!reloadConfig(s)) {
    notify("no valid tachyon.yml in the workspace root — create one (see the Tachyon README) and run 'Tachyon: Start' again", "warn");
    return;
  }

  // Re-discover sessions that survived a VSCode restart, then spawn pending autostarts.
  const surviving = await s.tmux.listSessions(`${SESSION_PREFIX}-${s.wsHash}-`);
  for (const session of surviving) {
    const agent = agentFromSession(s.wsHash, session);
    if (agent && !s.terminals.has(agent)) s.terminals.open(agent, session);
  }

  const pending = await s.manager.autostartPending();
  for (const agent of pending) {
    try {
      await s.manager.spawn(agent);
    } catch (err) {
      notify(`autostart of '${agent}' failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  rebuildWatches(s);

  if (surviving.length > 0) {
    notify(`re-attached ${surviving.length} surviving agent(s)${pending.length ? `, started ${pending.length}` : ""}`);
  } else if (pending.length > 0) {
    notify(`started ${pending.length} agent(s)`);
  }
}

async function connectRuntime(s: TachyonState): Promise<void> {
  const url = s.bridge.url;
  if (!url) {
    notify("Bridge is not running", "error");
    return;
  }
  const readWorkspaceFile = (rel: string): string | undefined => {
    const p = path.join(s.workspaceRoot, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;
  };
  let offers: RegistrationOffer[];
  try {
    offers = buildOffers(url, {
      claudeMcpJson: readWorkspaceFile(".mcp.json"),
      opencodeJson: readWorkspaceFile("opencode.json"),
    });
  } catch (err) {
    notify(`cannot build registration: ${err instanceof Error ? err.message : String(err)}`, "error");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    offers.map((o) => ({ label: o.title, detail: o.notes, offer: o })),
    { placeHolder: "Which agent runtime should connect to the Bridge?" },
  );
  if (!picked) return;
  const offer = picked.offer;

  if (offer.file && offer.content !== undefined) {
    const target = path.join(s.workspaceRoot, offer.file);
    if (fs.existsSync(target)) {
      const overwrite = await vscode.window.showWarningMessage(
        `${offer.file} exists — merge the 'tachyon' entry into it?`,
        { modal: true },
        "Merge",
      );
      if (overwrite !== "Merge") return;
    }
    fs.writeFileSync(target, offer.content, "utf8");
    notify(`${offer.file} updated — restart the agent runtime to pick it up`);
  } else {
    const doc = await vscode.workspace.openTextDocument({ content: offer.snippet, language: "plaintext" });
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.env.clipboard.writeText(offer.snippet);
    notify(`${offer.title}: snippet opened and copied to clipboard`);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const workspaceRoot = folder.uri.fsPath;

  // Fail closed without tmux (or on native Windows) — actionable message, no half-spawned state.
  const health = await doctor();
  if (!health.ok) {
    void vscode.window.showErrorMessage(`Tachyon: ${health.message}`);
    return;
  }

  const wsHash = workspaceHash(workspaceRoot);
  const tmux = new TmuxService();
  const terminals = new Terminals();
  const manager = new AgentManager({
    tmux,
    wsHash,
    workspaceRoot,
    getConfig: () => state?.config,
    getMaxAgents: () => vscode.workspace.getConfiguration("tachyon").get<number>("maxAgents") ?? 8,
    onSpawned: (name) => {
      if (state) terminals.open(name, manager.session(name));
      agentsView.refresh();
    },
    onKilled: (name) => {
      terminals.close(name);
      agentsView.refresh();
    },
  });
  const bridge = new Bridge({ manager, tmux, notify });
  const agentsView = new AgentsProvider(manager, () => bridge.url);
  const layoutsView = new LayoutsProvider(() => state?.config);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

  state = {
    workspaceRoot,
    wsHash,
    tmux,
    manager,
    terminals,
    bridge,
    watches: new WatchController(async () => {}),
    statusBar,
  };
  const s = state;

  try {
    const port = await bridge.start();
    statusBar.text = `$(zap) Tachyon :${port}`;
    statusBar.tooltip = `Tachyon Bridge (MCP) — ${bridge.url}`;
    statusBar.command = "tachyon.copyBridgeUrl";
    statusBar.show();
    agentsView.refresh(); // Bridge URL is now known
  } catch (err) {
    notify(`Bridge failed to start: ${err instanceof Error ? err.message : String(err)}`, "error");
  }

  // Sidebar: Agents (Bridge + agent states) and Layouts. Refreshed by lifecycle
  // events, the title-bar button, and tachyon.yml edits.
  const configWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, "tachyon.{yml,yaml}"),
  );
  const onConfigChange = () => {
    reloadConfig(s);
    rebuildWatches(s);
    agentsView.refresh();
    layoutsView.refresh();
  };
  configWatcher.onDidChange(onConfigChange);
  configWatcher.onDidCreate(onConfigChange);

  context.subscriptions.push(
    statusBar,
    terminals,
    configWatcher,
    vscode.window.registerTreeDataProvider("tachyonAgents", agentsView),
    vscode.window.registerTreeDataProvider("tachyonLayouts", layoutsView),
    { dispose: () => s.watches.dispose() },
    { dispose: () => void bridge.dispose() },
    vscode.commands.registerCommand("tachyon.refreshViews", () => {
      agentsView.refresh();
      layoutsView.refresh();
    }),
    vscode.commands.registerCommand("tachyon.spawnAgentItem", async (item: AgentTreeItem) => {
      try {
        await s.manager.spawn(item.agentName);
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.killAgentItem", async (item: AgentTreeItem) => {
      try {
        await s.manager.kill(item.agentName);
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.restartAgentItem", async (item: AgentTreeItem) => {
      try {
        await s.manager.restart(item.agentName);
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.openAgentTerminalItem", (agent: string) => {
      s.terminals.open(agent, s.manager.session(agent));
    }),
    vscode.commands.registerCommand("tachyon.start", async () => {
      await start(s);
      agentsView.refresh();
      layoutsView.refresh();
    }),
    vscode.commands.registerCommand("tachyon.stopAll", async () => {
      const killed = await s.manager.killAll();
      notify(killed.length > 0 ? `stopped ${killed.length} agent(s)` : "no agents running");
      agentsView.refresh();
    }),
    vscode.commands.registerCommand("tachyon.restartAgent", async () => {
      const agent = await pickAgent(s, "Restart which agent?", false);
      if (!agent) return;
      try {
        await s.manager.restart(agent);
        notify(`'${agent}' restarted`);
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.openAgentTerminal", async () => {
      const agent = await pickAgent(s, "Open which agent's terminal?", true);
      if (agent) s.terminals.open(agent, s.manager.session(agent));
    }),
    vscode.commands.registerCommand("tachyon.applyLayout", async (layoutName?: string) => {
      reloadConfig(s);
      const layouts = Object.entries(s.config?.layouts ?? {});
      if (layouts.length === 0) {
        notify("no layouts declared in tachyon.yml", "warn");
        return;
      }
      // Optional arg lets keybindings/automation apply a layout without the quick-pick.
      let name = layoutName;
      if (!name) {
        const picked = await vscode.window.showQuickPick(
          layouts.map(([n, def]) => ({ label: n, description: `${def.grid} — ${def.agents.join(", ")}` })),
          { placeHolder: "Apply which layout?" },
        );
        name = picked?.label;
      }
      if (!name) return;
      const def = s.config?.layouts[name];
      if (!def) {
        notify(`layout '${name}' is not declared in tachyon.yml`, "warn");
        return;
      }
      await applyLayout(def, s.terminals, (a) => s.manager.session(a));
    }),
    vscode.commands.registerCommand("tachyon.copyBridgeUrl", async () => {
      if (!s.bridge.url) {
        notify("Bridge is not running", "error");
        return;
      }
      await vscode.env.clipboard.writeText(s.bridge.url);
      notify(`Bridge URL copied: ${s.bridge.url}`);
    }),
    vscode.commands.registerCommand("tachyon.connectRuntime", () => connectRuntime(s)),
  );

  // workspaceContains:tachyon.yml activation → start orchestrating immediately.
  if (configPath(workspaceRoot)) {
    await start(s);
    agentsView.refresh();
    layoutsView.refresh();
  }
}

export function deactivate(): void {
  // tmux sessions intentionally survive — Tachyon re-attaches on next activation.
  state = undefined;
}
