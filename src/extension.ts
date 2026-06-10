import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs";
import {
  TmuxService,
  doctor,
  workspaceHash,
  SESSION_PREFIX,
} from "./tmux/TmuxService.js";
import { loadConfigFile, CONFIG_FILENAMES, type TachyonConfig } from "./config/loadConfig.js";
import { addAgent, cloneAgent, deleteAgent, renameAgent, upsertAgent, agentEntryLine } from "./config/YamlConfigEditor.js";
import { inferKind } from "./config/loadConfig.js";
import { openAgentStudio, type StudioSubmit } from "./webview/AgentForm.js";
import { validateForm, blockingErrors, toEntry } from "./webview/formLogic.js";
import { detectInstalledClis } from "./webview/cliDetect.js";
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
        notify(vscode.l10n.t("invalid attention pattern ignored: {0}", src), "warn");
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
    notify(vscode.l10n.t("invalid {0} — {1}{2}", path.basename(file), errors[0], errors.length > 1 ? vscode.l10n.t(" (+{0} more)", errors.length - 1) : ""), "error");
    return false;
  }
  s.config = config;
  return true;
}

async function pickAgent(s: TachyonState, placeholder: string, runningOnly: boolean): Promise<string | undefined> {
  const agents = await s.manager.list();
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

function rebuildWatches(s: TachyonState): void {
  s.watches.dispose();
  s.watches = new WatchController(async (agent) => {
    try {
      await s.manager.restart(agent);
      notify(vscode.l10n.t("'{0}' restarted (watched file changed)", agent));
    } catch (err) {
      notify(vscode.l10n.t("watch-restart of '{0}' failed: {1}", agent, err instanceof Error ? err.message : String(err)), "error");
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
    notify(vscode.l10n.t("no valid tachyon.yml in the workspace root — create one (see the Tachyon README) and run 'Tachyon: Start' again"), "warn");
    return;
  }

  // Re-discover sessions that survived a VSCode restart, then spawn pending autostarts.
  // Survivors are NOT auto-opened as tabs: terminals attached while their tab is hidden
  // render blank (stale client size). The sidebar shows them; a click opens the tab
  // already visible. Fresh spawns below still open their tab (onSpawned).
  const surviving = await s.tmux.listSessions(`${SESSION_PREFIX}-${s.wsHash}-`);

  const pending = await s.manager.autostartPending();
  for (const agent of pending) {
    try {
      await s.manager.spawn(agent);
    } catch (err) {
      notify(vscode.l10n.t("autostart of '{0}' failed: {1}", agent, err instanceof Error ? err.message : String(err)), "error");
    }
  }

  rebuildWatches(s);

  if (surviving.length > 0) {
    notify(vscode.l10n.t("{0} surviving agent(s) re-discovered — click them in the sidebar to open", surviving.length) + (pending.length ? vscode.l10n.t("; started {0}", pending.length) : ""));
  } else if (pending.length > 0) {
    notify(vscode.l10n.t("started {0} agent(s)", pending.length));
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
    notify(vscode.l10n.t("Bridge is not running"), "error");
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
    const target = path.join(s.workspaceRoot, offer.file);
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
  const terminals = new Terminals((_agent, session) => void tmux.refreshClients(session));

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
          .showInformationMessage(vscode.l10n.t("Tachyon: '{0}' needs you — {1}", agent, line), vscode.l10n.t("Open"))
          .then((choice) => {
            if (choice === vscode.l10n.t("Open")) terminals.open(agent, manager.session(agent));
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
        const code = exitCode !== undefined ? vscode.l10n.t(" (exit {0})", exitCode) : "";
        if (willRestart) {
          notify(vscode.l10n.t("'{0}' crashed{1} — restarting in {2}s", agent, code, Math.round((delayMs ?? 0) / 1000)), "warn");
        } else {
          void vscode.window
            .showErrorMessage(vscode.l10n.t("Tachyon: '{0}' crashed{1} — dead pane kept for postmortem", agent, code), vscode.l10n.t("Inspect"), vscode.l10n.t("Restart"))
            .then((choice) => {
              if (choice === vscode.l10n.t("Inspect")) terminals.open(agent, manager.session(agent));
              if (choice === vscode.l10n.t("Restart")) {
                void manager.restart(agent).catch((err) => notify(String(err instanceof Error ? err.message : err), "error"));
              }
            });
        }
      },
      onCleanExit: (agent) => {
        agentsView.refresh();
        notify(vscode.l10n.t("'{0}' exited cleanly", agent));
      },
      onGiveUp: (agent, attempts) => {
        agentsView.refresh();
        void vscode.window
          .showErrorMessage(
            vscode.l10n.t("Tachyon: '{0}' crash-looped ({1} restarts in 1 min) — giving up. Fix it and restart manually.", agent, attempts),
            vscode.l10n.t("Inspect"),
          )
          .then((choice) => {
            if (choice === vscode.l10n.t("Inspect")) terminals.open(agent, manager.session(agent));
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
    statusBar.tooltip = vscode.l10n.t("Tachyon Bridge (MCP) — {0}", bridge.url ?? "");
    statusBar.command = "tachyon.copyBridgeUrl";
    statusBar.show();
    agentsView.refresh(); // Bridge URL is now known
    if (bridge.usedFallback) {
      notify(
        vscode.l10n.t("Bridge port {0} is in use — fell back to {1}. Registered runtimes need re-connecting (or free the port and reload).", preferred, port),
        "warn",
      );
    }
  } catch (err) {
    notify(vscode.l10n.t("Bridge failed to start: {0}", err instanceof Error ? err.message : String(err)), "error");
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
      notify(vscode.l10n.t("bridgePort changed — reload the window to rebind the Bridge"), "warn");
    }
    if ((s.config?.settings.auth ?? true) !== authEnabled) {
      notify(vscode.l10n.t("settings.auth changed — reload the window to apply it"), "warn");
    }
  };
  configWatcher.onDidChange(onConfigChange);
  configWatcher.onDidCreate(onConfigChange);

  // Agent Studio submit pipeline — shared by the webview form and the internal
  // command the integration tests drive. Sync on purpose: blocking errors go back
  // to the form; success closes it.
  // Issue codes from formLogic mapped to localized messages at the UI boundary.
  const issueMessage = (issue: { code: string; param?: string }): string => {
    switch (issue.code) {
      case "name-invalid":
        return vscode.l10n.t("name: letters/digits/_/-, starting with a letter");
      case "name-taken":
        return vscode.l10n.t("name '{0}' already exists", issue.param ?? "");
      case "cmd-required":
        return vscode.l10n.t("command: required");
      case "instructions-not-deliverable":
        return vscode.l10n.t("note: this CLI doesn't accept a startup prompt — instructions will be saved but not auto-delivered");
      default:
        return issue.code;
    }
  };
  const studioSubmit = (submit: StudioSubmit): string[] | undefined => {
    const errors = blockingErrors(
      validateForm(submit.state, Object.keys(s.config?.agents ?? {}), submit.editingName),
    );
    if (errors.length > 0) return errors.map(issueMessage);
    const ok = mutateConfig(
      s,
      (text) => upsertAgent(text, submit.state.name, toEntry(submit.state), submit.editingName),
      () => agentsView.refresh(),
    );
    if (!ok) return [vscode.l10n.t("could not write tachyon.yml — see the notification")];
    notify(vscode.l10n.t("'{0}' saved — ▶ in the sidebar starts it", submit.state.name));
    return undefined;
  };
  const studioDeps = () => ({
    extensionUri: context.extensionUri,
    detectClis: detectInstalledClis,
    takenNames: () => Object.keys(s.config?.agents ?? {}),
    defaultCwd: s.workspaceRoot,
    inferKind,
    onSubmit: studioSubmit,
  });

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
    vscode.commands.registerCommand("tachyon._spawn", (name: string, opts?: { cmd?: string; cwd?: string; instructions?: string; parent?: string }) =>
      s.manager.spawn(name, opts),
    ),
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
          prompt: vscode.l10n.t("Pin a finding to the project's shared checklist"),
          placeHolder: vscode.l10n.t("e.g. dev server logs a deprecation warning on boot — investigate"),
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
    vscode.commands.registerCommand("tachyon._upsertAgent", (submit: StudioSubmit) => studioSubmit(submit)),
    vscode.commands.registerCommand("tachyon.agentStudio", async () => {
      reloadConfig(s);
      await openAgentStudio(studioDeps());
    }),
    vscode.commands.registerCommand("tachyon.editAgentStudioItem", async (item: AgentTreeItem) => {
      reloadConfig(s);
      const def = s.config?.agents[item.agentName];
      if (!def) {
        notify(vscode.l10n.t("'{0}' is not declared in tachyon.yml (ad-hoc agents have no stored definition)", item.agentName), "warn");
        return;
      }
      await openAgentStudio(studioDeps(), { name: item.agentName, def });
    }),
    vscode.commands.registerCommand("tachyon.newAgent", async (name?: string, cmd?: string, kindArg?: "agent" | "terminal") => {
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
      if (mutateConfig(s, (text) => addAgent(text, agentName, agentCmd, finalKind), () => agentsView.refresh())) {
        notify(vscode.l10n.t("'{0}' added — ▶ in the sidebar starts it", agentName));
      }
    }),
    vscode.commands.registerCommand("tachyon.cloneAgentItem", async (item: AgentTreeItem, newNameArg?: string) => {
      const newName =
        newNameArg ??
        (await vscode.window.showInputBox({
          prompt: vscode.l10n.t("Clone '{0}' as…", item.agentName),
          value: `${item.agentName}-2`,
          validateInput: (v) => (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(v) ? undefined : vscode.l10n.t("letters/digits/_/-, starting with a letter")),
        }));
      if (!newName) return;
      mutateConfig(s, (text) => cloneAgent(text ?? "", item.agentName, newName), () => agentsView.refresh());
    }),
    vscode.commands.registerCommand("tachyon.renameAgentItem", async (item: AgentTreeItem, newNameArg?: string) => {
      const running = (await s.manager.runningAgents()).includes(item.agentName);
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
      mutateConfig(s, (text) => renameAgent(text ?? "", item.agentName, newName), () => agentsView.refresh());
    }),
    vscode.commands.registerCommand("tachyon.deleteAgentItem", async (item: AgentTreeItem, forceArg?: boolean) => {
      const states = await s.manager.agentStates();
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
    vscode.commands.registerCommand("tachyon.start", async () => {
      await start(s);
      agentsView.refresh();
      layoutsView.refresh();
    }),
    vscode.commands.registerCommand("tachyon.stopAll", async () => {
      const killed = await s.manager.killAll();
      notify(killed.length > 0 ? vscode.l10n.t("stopped {0} agent(s)", killed.length) : vscode.l10n.t("no agents running"));
      agentsView.refresh();
    }),
    vscode.commands.registerCommand("tachyon.restartAgent", async () => {
      const agent = await pickAgent(s, vscode.l10n.t("Restart which agent?"), false);
      if (!agent) return;
      try {
        await s.manager.restart(agent);
        notify(vscode.l10n.t("'{0}' restarted", agent));
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.openAgentTerminal", async () => {
      const agent = await pickAgent(s, vscode.l10n.t("Open which agent's terminal?"), true);
      if (agent) s.terminals.open(agent, s.manager.session(agent));
    }),
    vscode.commands.registerCommand("tachyon.applyLayout", async (layoutName?: string) => {
      reloadConfig(s);
      const layouts = Object.entries(s.config?.layouts ?? {});
      if (layouts.length === 0) {
        notify(vscode.l10n.t("no layouts declared in tachyon.yml"), "warn");
        return;
      }
      // Optional arg lets keybindings/automation apply a layout without the quick-pick.
      let name = layoutName;
      if (!name) {
        const picked = await vscode.window.showQuickPick(
          layouts.map(([n, def]) => ({ label: n, description: `${def.grid} — ${def.agents.join(", ")}` })),
          { placeHolder: vscode.l10n.t("Apply which layout?") },
        );
        name = picked?.label;
      }
      if (!name) return;
      const def = s.config?.layouts[name];
      if (!def) {
        notify(vscode.l10n.t("layout '{0}' is not declared in tachyon.yml", name), "warn");
        return;
      }
      await applyLayout(def, s.terminals, (a) => s.manager.session(a));
    }),
    vscode.commands.registerCommand("tachyon.copyBridgeToken", async () => {
      if (!token) {
        notify(vscode.l10n.t("Bridge auth is disabled (settings.auth: false) — no token"), "warn");
        return;
      }
      await vscode.env.clipboard.writeText(token);
      notify(vscode.l10n.t("Bridge token copied — export it as TACHYON_BRIDGE_TOKEN for external agents"));
    }),
    vscode.commands.registerCommand("tachyon.copyBridgeUrl", async () => {
      if (!s.bridge.url) {
        notify(vscode.l10n.t("Bridge is not running"), "error");
        return;
      }
      await vscode.env.clipboard.writeText(s.bridge.url);
      notify(vscode.l10n.t("Bridge URL copied: {0}", s.bridge.url));
    }),
    vscode.commands.registerCommand("tachyon.connectRuntime", () => connectRuntime(s)),
  );

  // Upgrade notice: MCP clients cache the Bridge tool schema at THEIR session start.
  // Agents that survived an extension upgrade keep the old tool list until restarted.
  const currentVersion = (context.extension.packageJSON as { version: string }).version;
  const lastVersion = context.globalState.get<string>(`tachyon.version.${wsHash}`);
  if (lastVersion && lastVersion !== currentVersion && (await manager.runningAgents()).length > 0) {
    notify(
      vscode.l10n.t(
        "Tachyon was updated ({0} → {1}) — running agents keep the old Bridge tools until restarted (↻ in the sidebar)",
        lastVersion,
        currentVersion,
      ),
      "warn",
    );
  }
  void context.globalState.update(`tachyon.version.${wsHash}`, currentVersion);

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
