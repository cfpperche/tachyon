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
import { addAgent, cloneAgent, deleteAgent, renameAgent, agentEntryLine } from "./config/YamlConfigEditor.js";
import { inferKind } from "./config/loadConfig.js";
import { AgentManager, WatchController } from "./agents/AgentManager.js";
import { Terminals } from "./presentation/Terminals.js";
import { applyLayout } from "./presentation/Layouts.js";
import { Bridge, derivePort } from "./bridge/Bridge.js";
import { loadOrCreateToken, TOKEN_ENV_VAR, URL_ENV_VAR } from "./bridge/token.js";
import { buildOffers, type RegistrationOffer } from "./registration/adapters.js";
import type { NotifyLevel } from "./bridge/tools.js";
import { AgentsProvider, LayoutsProvider, PinsProvider, type AgentTreeItem, type PinTreeItem } from "./presentation/Sidebar.js";
import { PinStore } from "./pins/PinStore.js";
import { AttentionMonitor } from "./attention/AttentionMonitor.js";
import { LifecycleMonitor } from "./agents/LifecycleMonitor.js";
import { compileExtraPatterns } from "./attention/patterns.js";
import { subtreeCpuTicks } from "./attention/cpu.js";

const ATTENTION_POLL_MS = 3000;

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

const warnedPatterns = new Set<string>();

/** Compiles per-agent extra patterns, dropping (and warning once about) invalid regexes. */
function safePatterns(sources: string[]): RegExp[] {
  const good: RegExp[] = [];
  for (const src of sources) {
    try {
      good.push(...compileExtraPatterns([src]));
    } catch {
      if (!warnedPatterns.has(src)) {
        warnedPatterns.add(src);
        notify(`invalid attention pattern ignored: ${src}`, "warn");
      }
    }
  }
  return good;
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

/**
 * Applies a UI-driven mutation to tachyon.yml (the file stays the source of truth),
 * then reloads config and refreshes the views. Surfaces warnings (e.g. layout cleanups).
 */
function mutateConfig(
  s: TachyonState,
  mutate: (text: string | undefined) => { text: string; warnings: string[] },
  afterReload?: () => void,
): boolean {
  const file = configPath(s.workspaceRoot) ?? path.join(s.workspaceRoot, "tachyon.yml");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  try {
    const { text, warnings } = mutate(existing);
    fs.writeFileSync(file, text, "utf8");
    reloadConfig(s);
    rebuildWatches(s);
    afterReload?.();
    for (const warning of warnings) notify(warning, "warn");
    return true;
  } catch (err) {
    notify(`${err instanceof Error ? err.message : String(err)}`, "error");
    return false;
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
    offers = buildOffers(
      url,
      {
        claudeMcpJson: readWorkspaceFile(".mcp.json"),
        opencodeJson: readWorkspaceFile("opencode.json"),
      },
      (s.config?.settings.auth ?? true),
    );
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
    if (offer.upToDate) {
      notify(`${offer.file} already registers the Bridge at ${url} — nothing to do`);
      return;
    }
    // Idempotent merge: only the 'tachyon' key is (re)written; every other MCP
    // entry in a pre-existing file is preserved untouched.
    const target = path.join(s.workspaceRoot, offer.file);
    fs.writeFileSync(target, offer.content, "utf8");
    notify(`${offer.file}: tachyon entry set to ${url} — restart the agent runtime to pick it up`);
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

  // Auth: stable per-workspace token (extension storage — never in a committable
  // file), required as a Bearer header unless settings.auth: false. Resolved early
  // because both the Bridge and the env injection below need it.
  const earlyConfigFile = configPath(workspaceRoot);
  const earlyConfig = earlyConfigFile ? loadConfigFile(earlyConfigFile).config : undefined;
  const authEnabled = earlyConfig?.settings.auth ?? true;
  const token = authEnabled ? loadOrCreateToken(context.globalStorageUri.fsPath, wsHash) : undefined;

  const manager = new AgentManager({
    tmux,
    wsHash,
    workspaceRoot,
    getConfig: () => state?.config,
    getMaxAgents: () => vscode.workspace.getConfiguration("tachyon").get<number>("maxAgents") ?? 8,
    getExtraEnv: () => {
      // Every Tachyon-spawned session can reach (and authenticate to) the Bridge.
      const env: Record<string, string> = {};
      if (bridge.url) env[URL_ENV_VAR] = bridge.url;
      if (token) env[TOKEN_ENV_VAR] = token;
      return env;
    },
    onSpawned: (name) => {
      if (state) terminals.open(name, manager.session(name));
      agentsView.refresh();
    },
    onKilled: (name) => {
      terminals.close(name);
      agentsView.refresh();
    },
  });
  const monitor = new AttentionMonitor(
    {
      runningAgents: () => manager.runningAgents(),
      capturePane: (agent) => tmux.capturePane(manager.session(agent)),
      cpuTicks: async (agent) => {
        try {
          return subtreeCpuTicks(await tmux.panePid(manager.session(agent)));
        } catch {
          return null;
        }
      },
      settingsOf: (agent) => {
        const att = state?.config?.agents[agent]?.attention;
        // Ad-hoc agents (spawned via the Bridge, not declared) get attention by default.
        if (!att) return { enabled: true, silenceSec: 8, patterns: [] };
        return { enabled: att.enabled, silenceSec: att.silenceSec, patterns: safePatterns(att.patterns) };
      },
      now: () => Date.now(),
    },
    (agent, attention, shouldToast) => {
      agentsView.refresh();
      updateAttentionBadge();
      if (shouldToast && attention.state === "needs-input") {
        const line = attention.matchedLine ?? "waiting for input";
        void vscode.window
          .showInformationMessage(`Tachyon: '${agent}' needs you — ${line}`, "Open")
          .then((choice) => {
            if (choice === "Open") terminals.open(agent, manager.session(agent));
          });
      }
    },
  );
  const lifecycle = new LifecycleMonitor(
    {
      agentStates: () => manager.agentStates(),
      policyOf: (agent) => state?.config?.agents[agent]?.restart ?? "never",
      scheduleRestart: (agent, delayMs) => {
        setTimeout(() => {
          manager.restart(agent).catch((err) => {
            notify(`auto-restart of '${agent}' failed: ${err instanceof Error ? err.message : String(err)}`, "error");
          });
        }, delayMs);
      },
      now: () => Date.now(),
    },
    {
      onCrash: (agent, exitCode, willRestart, delayMs) => {
        agentsView.refresh();
        const code = exitCode !== undefined ? ` (exit ${exitCode})` : "";
        if (willRestart) {
          notify(`'${agent}' crashed${code} — restarting in ${Math.round((delayMs ?? 0) / 1000)}s`, "warn");
        } else {
          void vscode.window
            .showErrorMessage(`Tachyon: '${agent}' crashed${code} — dead pane kept for postmortem`, "Inspect", "Restart")
            .then((choice) => {
              if (choice === "Inspect") terminals.open(agent, manager.session(agent));
              if (choice === "Restart") {
                void manager.restart(agent).catch((err) => notify(String(err instanceof Error ? err.message : err), "error"));
              }
            });
        }
      },
      onCleanExit: (agent) => {
        agentsView.refresh();
        notify(`'${agent}' exited cleanly`);
      },
      onGiveUp: (agent, attempts) => {
        agentsView.refresh();
        void vscode.window
          .showErrorMessage(
            `Tachyon: '${agent}' crash-looped (${attempts} restarts in 1 min) — giving up. Fix it and restart manually.`,
            "Inspect",
          )
          .then((choice) => {
            if (choice === "Inspect") terminals.open(agent, manager.session(agent));
          });
      },
    },
  );
  const pinStore = new PinStore(workspaceRoot);
  const pinsView = new PinsProvider(pinStore);
  const bridge = new Bridge(
    {
      manager,
      tmux,
      pins: pinStore,
      notify,
      attentionOf: (agent) => monitor.stateOf(agent)?.state,
      onPinsChanged: () => pinsView.refresh(),
    },
    { token },
  );
  const agentsView = new AgentsProvider(manager, () => bridge.url, (agent) => monitor.stateOf(agent));
  const layoutsView = new LayoutsProvider(() => state?.config);
  let agentsTree: vscode.TreeView<vscode.TreeItem> | undefined;
  const updateAttentionBadge = () => {
    if (!agentsTree) return;
    const n = monitor.needsInputCount();
    agentsTree.badge = n > 0 ? { value: n, tooltip: `${n} agent(s) need your input` } : undefined;
  };
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
    // Load config before the Bridge so settings.bridgePort applies; default is a
    // stable per-workspace derived port, so registrations survive editor restarts.
    reloadConfig(s);
    const preferred = s.config?.settings.bridgePort ?? derivePort(wsHash);
    const port = await bridge.start(preferred);
    statusBar.text = `$(zap) Tachyon :${port}`;
    statusBar.tooltip = `Tachyon Bridge (MCP) — ${bridge.url}`;
    statusBar.command = "tachyon.copyBridgeUrl";
    statusBar.show();
    agentsView.refresh(); // Bridge URL is now known
    if (bridge.usedFallback) {
      notify(
        `Bridge port ${preferred} is in use — fell back to ${port}. Registered runtimes need re-connecting (or free the port and reload).`,
        "warn",
      );
    }
  } catch (err) {
    notify(`Bridge failed to start: ${err instanceof Error ? err.message : String(err)}`, "error");
  }

  // Sidebar: Agents (Bridge + agent states) and Layouts. Refreshed by lifecycle
  // events, the title-bar button, and tachyon.yml edits.
  const configWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, "tachyon.{yml,yaml}"),
  );
  const onConfigChange = () => {
    const portBefore = s.config?.settings.bridgePort;
    reloadConfig(s);
    rebuildWatches(s);
    agentsView.refresh();
    layoutsView.refresh();
    if (s.config?.settings.bridgePort !== portBefore) {
      notify("bridgePort changed — reload the window to rebind the Bridge", "warn");
    }
    if ((s.config?.settings.auth ?? true) !== authEnabled) {
      notify("settings.auth changed — reload the window to apply it", "warn");
    }
  };
  configWatcher.onDidChange(onConfigChange);
  configWatcher.onDidCreate(onConfigChange);

  agentsTree = vscode.window.createTreeView("tachyonAgents", { treeDataProvider: agentsView });
  const pinsTree = vscode.window.createTreeView("tachyonPins", { treeDataProvider: pinsView });
  pinsTree.onDidChangeCheckboxState((e) => {
    for (const [item, checkboxState] of e.items) {
      const pin = item as PinTreeItem;
      try {
        pinStore.setDone(pin.pinId, checkboxState === vscode.TreeItemCheckboxState.Checked);
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }
    pinsView.refresh();
  });
  // Manual edits to .tachyon/* (or agent writes through the Bridge in another window) reflect live.
  const pinsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, ".tachyon/*"),
  );
  pinsWatcher.onDidChange(() => pinsView.refresh());
  pinsWatcher.onDidCreate(() => pinsView.refresh());
  pinsWatcher.onDidDelete(() => pinsView.refresh());
  const attentionTicker = setInterval(() => {
    void lifecycle.tick();
    void monitor.tick().then(() => {
      // States with durations ("idle 2m") need periodic re-render even without transitions.
      agentsView.refresh();
    });
  }, ATTENTION_POLL_MS);

  context.subscriptions.push(
    statusBar,
    terminals,
    configWatcher,
    agentsTree,
    pinsTree,
    pinsWatcher,
    { dispose: () => clearInterval(attentionTicker) },
    vscode.window.registerTreeDataProvider("tachyonLayouts", layoutsView),
    { dispose: () => s.watches.dispose() },
    { dispose: () => void bridge.dispose() },
    vscode.commands.registerCommand("tachyon._agents", () => s.manager.list()),
    vscode.commands.registerCommand("tachyon._attention", () => {
      const out: Record<string, { state: string; matchedLine?: string }> = {};
      for (const [agent, att] of monitor.states()) {
        out[agent] = { state: att.state, matchedLine: att.matchedLine };
      }
      return out;
    }),
    vscode.commands.registerCommand("tachyon.refreshViews", () => {
      agentsView.refresh();
      layoutsView.refresh();
      pinsView.refresh();
    }),
    vscode.commands.registerCommand("tachyon.addPin", async (text?: string) => {
      const value =
        text ??
        (await vscode.window.showInputBox({
          prompt: "Pin a finding to the project's shared checklist",
          placeHolder: "e.g. dev server logs a deprecation warning on boot — investigate",
        }));
      if (!value || value.trim().length === 0) return;
      try {
        pinStore.create(value, "human");
        pinsView.refresh();
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.deletePinItem", (item: PinTreeItem) => {
      try {
        pinStore.remove(item.pinId);
        pinsView.refresh();
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.openNotes", async () => {
      const file = pinStore.ensureNotesFile();
      const doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    vscode.commands.registerCommand("tachyon._pins", () => pinStore.list()),
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
        lifecycle.resetBackoff(item.agentName); // human took over — clear crash-loop history
        await s.manager.restart(item.agentName);
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.openAgentTerminalItem", (agent: string) => {
      s.terminals.open(agent, s.manager.session(agent));
    }),
    vscode.commands.registerCommand("tachyon.newAgent", async (name?: string, cmd?: string, kindArg?: "agent" | "terminal") => {
      const agentName =
        name ??
        (await vscode.window.showInputBox({
          prompt: "Agent name (a free label — e.g. frontend, reviewer, dev)",
          validateInput: (v) => (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(v) ? undefined : "letters/digits/_/-, starting with a letter"),
        }));
      if (!agentName) return;
      const agentCmd =
        cmd ??
        (await vscode.window.showInputBox({
          prompt: `Command for '${agentName}' (what actually runs)`,
          placeHolder: "e.g. claude · codex · npm run dev",
        }));
      if (!agentCmd) return;
      let kind = kindArg;
      if (!kind && name === undefined) {
        // Interactive flow: confirm the inferred kind (drives grouping + attention defaults).
        const inferred = inferKind(agentCmd);
        const picked = await vscode.window.showQuickPick(
          [
            { label: "Agent", description: "AI CLI — attention detection on", value: "agent" },
            { label: "Terminal", description: "server / shell / build — attention off", value: "terminal" },
          ].sort((a) => (a.value === inferred ? -1 : 1)),
          { placeHolder: `Kind of '${agentName}' (detected: ${inferred})` },
        );
        if (!picked) return;
        kind = picked.value as "agent" | "terminal";
      }
      const finalKind = kind && kind !== inferKind(agentCmd) ? kind : undefined; // write only when it differs from inference
      if (mutateConfig(s, (text) => addAgent(text, agentName, agentCmd, finalKind), () => agentsView.refresh())) {
        notify(`'${agentName}' added — ▶ in the sidebar starts it`);
      }
    }),
    vscode.commands.registerCommand("tachyon.cloneAgentItem", async (item: AgentTreeItem, newNameArg?: string) => {
      const newName =
        newNameArg ??
        (await vscode.window.showInputBox({
          prompt: `Clone '${item.agentName}' as…`,
          value: `${item.agentName}-2`,
          validateInput: (v) => (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(v) ? undefined : "letters/digits/_/-, starting with a letter"),
        }));
      if (!newName) return;
      mutateConfig(s, (text) => cloneAgent(text ?? "", item.agentName, newName), () => agentsView.refresh());
    }),
    vscode.commands.registerCommand("tachyon.renameAgentItem", async (item: AgentTreeItem, newNameArg?: string) => {
      const running = (await s.manager.runningAgents()).includes(item.agentName);
      if (running) {
        notify(`'${item.agentName}' is running — stop it before renaming (its session carries the old name)`, "warn");
        return;
      }
      const newName =
        newNameArg ??
        (await vscode.window.showInputBox({
          prompt: `Rename '${item.agentName}' to…`,
          value: item.agentName,
          validateInput: (v) => (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(v) ? undefined : "letters/digits/_/-, starting with a letter"),
        }));
      if (!newName || newName === item.agentName) return;
      mutateConfig(s, (text) => renameAgent(text ?? "", item.agentName, newName), () => agentsView.refresh());
    }),
    vscode.commands.registerCommand("tachyon.deleteAgentItem", async (item: AgentTreeItem, forceArg?: boolean) => {
      const states = await s.manager.agentStates();
      const hasSession = states.has(item.agentName);
      if (!forceArg) {
        const answer = await vscode.window.showWarningMessage(
          `Delete agent '${item.agentName}' from tachyon.yml?${hasSession ? " Its tmux session will be killed too." : ""}`,
          { modal: true },
          "Delete",
        );
        if (answer !== "Delete") return;
      }
      if (hasSession) {
        try {
          await s.manager.kill(item.agentName);
        } catch (err) {
          notify(`${err instanceof Error ? err.message : String(err)}`, "error");
        }
      }
      mutateConfig(s, (text) => deleteAgent(text ?? "", item.agentName), () => agentsView.refresh());
    }),
    vscode.commands.registerCommand("tachyon.editAgentItem", async (item: AgentTreeItem) => {
      const file = configPath(s.workspaceRoot);
      if (!file) {
        notify("no tachyon.yml in this workspace", "warn");
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
    vscode.commands.registerCommand("tachyon.copyBridgeToken", async () => {
      if (!token) {
        notify("Bridge auth is disabled (settings.auth: false) — no token", "warn");
        return;
      }
      await vscode.env.clipboard.writeText(token);
      notify("Bridge token copied — export it as TACHYON_BRIDGE_TOKEN for external agents");
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
