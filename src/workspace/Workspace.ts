import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs";
import { TmuxService, workspaceHash, SESSION_PREFIX } from "../tmux/TmuxService.js";
import { ControlModeClient } from "../tmux/ControlModeClient.js";
import { loadConfigFile, CONFIG_FILENAMES, inferKind, type TachyonConfig } from "../config/loadConfig.js";
import { upsertAgent, upsertCommand, upsertRunbook, upsertLayout } from "../config/YamlConfigEditor.js";
import { AgentManager, WatchController } from "../agents/AgentManager.js";
import { LifecycleMonitor } from "../agents/LifecycleMonitor.js";
import { AttentionMonitor, type AgentAttention } from "../attention/AttentionMonitor.js";
import { compileExtraPatterns } from "../attention/patterns.js";
import { subtreeCpuTicks } from "../attention/cpu.js";
import { Waiters } from "../bridge/Waiters.js";
import { Bridge, derivePort } from "../bridge/Bridge.js";
import { loadOrCreateToken, TOKEN_ENV_VAR, URL_ENV_VAR } from "../bridge/token.js";
import { CMD_WAIT_PREFIX } from "../bridge/tools.js";
import { CommandRunner } from "../commands/CommandRunner.js";
import { RunbookRunner } from "../commands/RunbookRunner.js";
import { PinStore } from "../pins/PinStore.js";
import { Terminals } from "../presentation/Terminals.js";
import { applyLayout } from "../presentation/Layouts.js";
import { captureToEntry } from "../presentation/layoutLogic.js";
import { detectInstalledClis } from "../webview/cliDetect.js";
import { validateForm, blockingErrors, toEntry } from "../webview/formLogic.js";
import type { StudioSubmit, StudioDeps } from "../webview/AgentForm.js";
import { notify } from "./notify.js";

const ATTENTION_POLL_MS = 3000;

/** Which sidebar surface a Workspace event touches. */
export type ViewKind = "agents" | "layouts" | "pins" | "commands";

export interface WorkspaceDeps {
  context: vscode.ExtensionContext;
  /** refresh the (global) sidebar providers + the attention badge */
  onViewsChanged: (view: ViewKind) => void;
}

const warnedPatterns = new Set<string>();

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

const issueMessage = (issue: { code: string; param?: string }): string => {
  switch (issue.code) {
    case "name-invalid":
      return vscode.l10n.t("name: letters/digits/_/-, starting with a letter");
    case "name-taken":
      return vscode.l10n.t("name '{0}' already exists", issue.param ?? "");
    case "cmd-required":
      return vscode.l10n.t("command: required");
    case "steps-required":
      return vscode.l10n.t("steps: at least one step is required");
    case "instructions-not-deliverable":
      return vscode.l10n.t("note: this CLI doesn't accept a startup prompt — instructions will be saved but not auto-delivered");
    default:
      return issue.code;
  }
};

/**
 * Everything Tachyon runs FOR ONE FOLDER — config, agents, monitors, runners,
 * Bridge, engine, pins, watchers. The extension holds a registry of these
 * (multi-root, F9); the isolation underneath (tmux namespace, token, derived
 * port, .tachyon/ files) was always per-folder via wsHash, so this class is
 * the organizational seam, not new isolation.
 */
export class Workspace {
  readonly wsHash: string;
  readonly tmux: TmuxService;
  readonly terminals: Terminals;
  readonly manager: AgentManager;
  readonly monitor: AttentionMonitor;
  readonly waiters: Waiters;
  readonly lifecycle: LifecycleMonitor;
  readonly pinStore: PinStore;
  readonly commandRunner: CommandRunner;
  readonly runbookRunner: RunbookRunner;
  readonly bridge: Bridge;
  readonly token: string | undefined;
  readonly authEnabled: boolean;
  config: TachyonConfig | undefined;

  private readonly engine: ControlModeClient;
  private watches: WatchController;
  private readonly disposables: vscode.Disposable[] = [];
  private lifecycleTrigger: NodeJS.Timeout | undefined;
  private ticker: NodeJS.Timeout | undefined;
  private engineWarned = false;

  private constructor(
    readonly workspaceRoot: string,
    private readonly deps: WorkspaceDeps,
  ) {
    this.wsHash = workspaceHash(workspaceRoot);
    this.tmux = new TmuxService();
    // F20 engine: persistent control-mode client — command channel (zero
    // subprocess churn) + event-driven lifecycle; subprocess fallback when down.
    this.engine = new ControlModeClient({
      wsHash: this.wsHash,
      onDeadMapChanged: () => this.triggerLifecycle(),
      onSessionsChanged: () => this.triggerLifecycle(),
      onStateChange: (isUp) => {
        if (!isUp && !this.engineWarned) {
          this.engineWarned = true;
          console.warn(`Tachyon[${this.folderName}]: control-mode engine down — subprocess fallback (reconnecting)`);
        }
        if (isUp) this.engineWarned = false;
      },
    });
    this.tmux.useExecutor(this.engine.makeExecutor());
    this.terminals = new Terminals((_agent, session) => void this.tmux.refreshClients(session));

    // Auth: stable per-workspace token (extension storage — never in a committable file).
    const earlyFile = this.configPath();
    const earlyConfig = earlyFile ? loadConfigFile(earlyFile).config : undefined;
    this.authEnabled = earlyConfig?.settings.auth ?? true;
    this.token = this.authEnabled ? loadOrCreateToken(deps.context.globalStorageUri.fsPath, this.wsHash) : undefined;

    this.manager = new AgentManager({
      tmux: this.tmux,
      wsHash: this.wsHash,
      workspaceRoot,
      getConfig: () => this.config,
      getMaxAgents: () => vscode.workspace.getConfiguration("tachyon").get<number>("maxAgents") ?? 8,
      getExtraEnv: () => {
        // Every Tachyon-spawned session can reach (and authenticate to) ITS folder's Bridge.
        const env: Record<string, string> = {};
        if (this.bridge.url) env[URL_ENV_VAR] = this.bridge.url;
        if (this.token) env[TOKEN_ENV_VAR] = this.token;
        return env;
      },
      onSpawned: (name) => {
        this.terminals.open(name, this.manager.session(name));
        deps.onViewsChanged("agents");
      },
      onKilled: (name) => {
        this.terminals.close(name);
        deps.onViewsChanged("agents");
      },
    });

    this.waiters = new Waiters();
    this.monitor = new AttentionMonitor(
      {
        runningAgents: () => this.manager.runningAgents(),
        capturePane: (agent) => this.tmux.capturePane(this.manager.session(agent)),
        cpuTicks: async (agent) => {
          try {
            return subtreeCpuTicks(await this.tmux.panePid(this.manager.session(agent)));
          } catch {
            return null;
          }
        },
        settingsOf: (agent) => {
          const att = this.config?.agents[agent]?.attention;
          // Ad-hoc agents (spawned via the Bridge, not declared) get attention by default.
          if (!att) return { enabled: true, silenceSec: 8, patterns: [] };
          return { enabled: att.enabled, silenceSec: att.silenceSec, patterns: safePatterns(att.patterns) };
        },
        now: () => Date.now(),
      },
      (agent, attention, shouldToast) => {
        this.waiters.notifyAttention(agent, attention.state);
        deps.onViewsChanged("agents");
        if (shouldToast && attention.state === "needs-input") {
          const line = attention.matchedLine ?? "waiting for input";
          void vscode.window
            .showInformationMessage(vscode.l10n.t("Tachyon: '{0}' needs you — {1}", agent, line), vscode.l10n.t("Open"))
            .then((choice) => {
              if (choice === vscode.l10n.t("Open")) this.terminals.open(agent, this.manager.session(agent));
            });
        }
      },
    );

    this.lifecycle = new LifecycleMonitor(
      {
        agentStates: () => this.manager.agentStates(),
        policyOf: (agent) => this.config?.agents[agent]?.restart ?? "never",
        scheduleRestart: (agent, delayMs) => {
          setTimeout(() => {
            this.manager.restart(agent).catch((err) => {
              notify(`auto-restart of '${agent}' failed: ${err instanceof Error ? err.message : String(err)}`, "error");
            });
          }, delayMs);
        },
        now: () => Date.now(),
      },
      {
        onCrash: (agent, exitCode, willRestart, delayMs) => {
          this.waiters.notifyDead(agent, exitCode);
          deps.onViewsChanged("agents");
          const code = exitCode !== undefined ? vscode.l10n.t(" (exit {0})", exitCode) : "";
          if (willRestart) {
            notify(vscode.l10n.t("'{0}' crashed{1} — restarting in {2}s", agent, code, Math.round((delayMs ?? 0) / 1000)), "warn");
          } else {
            void vscode.window
              .showErrorMessage(vscode.l10n.t("Tachyon: '{0}' crashed{1} — dead pane kept for postmortem", agent, code), vscode.l10n.t("Inspect"), vscode.l10n.t("Restart"))
              .then((choice) => {
                if (choice === vscode.l10n.t("Inspect")) this.terminals.open(agent, this.manager.session(agent));
                if (choice === vscode.l10n.t("Restart")) {
                  void this.manager.restart(agent).catch((err) => notify(String(err instanceof Error ? err.message : err), "error"));
                }
              });
          }
        },
        onCleanExit: (agent) => {
          this.waiters.notifyDead(agent, 0);
          deps.onViewsChanged("agents");
          notify(vscode.l10n.t("'{0}' exited cleanly", agent));
        },
        onGone: (agent) => this.waiters.notifyGone(agent),
        onGiveUp: (agent, attempts) => {
          deps.onViewsChanged("agents");
          void vscode.window
            .showErrorMessage(
              vscode.l10n.t("Tachyon: '{0}' crash-looped ({1} restarts in 1 min) — giving up. Fix it and restart manually.", agent, attempts),
              vscode.l10n.t("Inspect"),
            )
            .then((choice) => {
              if (choice === vscode.l10n.t("Inspect")) this.terminals.open(agent, this.manager.session(agent));
            });
        },
      },
    );

    this.pinStore = new PinStore(workspaceRoot);

    // One-shot commands + runbooks (F15/F21): own tmux namespaces, inverted lifecycle.
    this.commandRunner = new CommandRunner({
      tmux: this.tmux,
      wsHash: this.wsHash,
      workspaceRoot,
      getConfig: () => this.config,
      onFinished: (name, exitCode, durationMs) => {
        this.waiters.notifyDead(`${CMD_WAIT_PREFIX}${name}`, exitCode);
        deps.onViewsChanged("commands");
        if (exitCode === 0) {
          notify(vscode.l10n.t("command '{0}' passed ({1}s)", name, Math.round((durationMs ?? 0) / 1000)));
        } else {
          void vscode.window
            .showErrorMessage(vscode.l10n.t("Tachyon: command '{0}' failed (exit {1})", name, exitCode ?? "?"), vscode.l10n.t("Inspect"))
            .then((choice) => {
              if (choice === vscode.l10n.t("Inspect")) this.openCommandPane(name);
            });
        }
      },
    });
    this.runbookRunner = new RunbookRunner({
      tmux: this.tmux,
      wsHash: this.wsHash,
      workspaceRoot,
      getConfig: () => this.config,
      onFinished: (job) => {
        deps.onViewsChanged("commands");
        if (job.outcome === "passed") {
          notify(vscode.l10n.t("runbook '{0}' passed ({1} steps)", job.runbook, job.steps.length));
        } else {
          const failed = job.steps.find((st) => st.state === "failed");
          void vscode.window
            .showErrorMessage(
              vscode.l10n.t("Tachyon: runbook '{0}' failed at step {1} ({2})", job.runbook, (failed?.index ?? 0) + 1, failed?.step ?? "?"),
              vscode.l10n.t("Inspect"),
            )
            .then((choice) => {
              if (choice === vscode.l10n.t("Inspect") && failed) this.openRunbookStepPane(job.runbook, failed.index);
            });
        }
      },
    });

    this.bridge = new Bridge(
      {
        manager: this.manager,
        tmux: this.tmux,
        pins: this.pinStore,
        notify,
        attentionOf: (agent) => this.monitor.stateOf(agent)?.state,
        onPinsChanged: () => deps.onViewsChanged("pins"),
        waiters: this.waiters,
        commands: this.commandRunner,
        runbooks: this.runbookRunner,
      },
      { token: this.token },
    );

    this.watches = new WatchController(async () => {});
  }

  /** Builds, boots the Bridge/engine/watchers, and (if configured) starts agents. */
  static async create(workspaceRoot: string, deps: WorkspaceDeps): Promise<Workspace> {
    const ws = new Workspace(workspaceRoot, deps);
    void ws.engine.start().catch(() => {
      /* degraded from birth — executor falls back, reconnect loop is running */
    });

    try {
      // Load config before the Bridge so settings.bridgePort applies; default is a
      // stable per-workspace derived port, so registrations survive editor restarts.
      ws.reloadConfig();
      const preferred = ws.config?.settings.bridgePort ?? derivePort(ws.wsHash);
      const port = await ws.bridge.start(preferred);
      if (ws.bridge.usedFallback) {
        notify(
          vscode.l10n.t("Bridge port {0} is in use — fell back to {1}. Registered runtimes need re-connecting (or free the port and reload).", preferred, port),
          "warn",
        );
      }
    } catch (err) {
      notify(vscode.l10n.t("Bridge failed to start: {0}", err instanceof Error ? err.message : String(err)), "error");
    }

    // tachyon.yml edits reflect live (config + watches + views).
    const configWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, "tachyon.{yml,yaml}"),
    );
    const onConfigChange = () => {
      const portBefore = ws.config?.settings.bridgePort;
      ws.reloadConfig();
      ws.rebuildWatches();
      deps.onViewsChanged("agents");
      deps.onViewsChanged("layouts");
      deps.onViewsChanged("commands");
      if (ws.config?.settings.bridgePort !== portBefore) {
        notify(vscode.l10n.t("bridgePort changed — reload the window to rebind the Bridge"), "warn");
      }
      if ((ws.config?.settings.auth ?? true) !== ws.authEnabled) {
        notify(vscode.l10n.t("settings.auth changed — reload the window to apply it"), "warn");
      }
    };
    configWatcher.onDidChange(onConfigChange);
    configWatcher.onDidCreate(onConfigChange);
    ws.disposables.push(configWatcher);

    // Manual edits to .tachyon/* (or agent writes through another window) reflect live.
    const pinsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, ".tachyon/*"),
    );
    pinsWatcher.onDidChange(() => deps.onViewsChanged("pins"));
    pinsWatcher.onDidCreate(() => deps.onViewsChanged("pins"));
    pinsWatcher.onDidDelete(() => deps.onViewsChanged("pins"));
    ws.disposables.push(pinsWatcher);

    ws.ticker = setInterval(() => void ws.tick(), ATTENTION_POLL_MS);

    // Upgrade notice: MCP clients cache the Bridge tool schema at THEIR session start.
    const currentVersion = (deps.context.extension.packageJSON as { version: string }).version;
    const lastVersion = deps.context.globalState.get<string>(`tachyon.version.${ws.wsHash}`);
    if (lastVersion && lastVersion !== currentVersion && (await ws.manager.runningAgents()).length > 0) {
      notify(
        vscode.l10n.t(
          "Tachyon was updated ({0} → {1}) — running agents keep the old Bridge tools until restarted (↻ in the sidebar)",
          lastVersion,
          currentVersion,
        ),
        "warn",
      );
    }
    void deps.context.globalState.update(`tachyon.version.${ws.wsHash}`, currentVersion);

    return ws;
  }

  get folderName(): string {
    return path.basename(this.workspaceRoot);
  }

  /** sidebar accessors */
  bridgeUrl(): string | undefined {
    return this.bridge.url;
  }
  attentionOf(agent: string): AgentAttention | undefined {
    return this.monitor.stateOf(agent);
  }

  configPath(): string | undefined {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(this.workspaceRoot, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  reloadConfig(): boolean {
    const file = this.configPath();
    if (!file) {
      this.config = undefined;
      return false;
    }
    const { config, errors } = loadConfigFile(file);
    if (errors.length > 0) {
      notify(vscode.l10n.t("invalid {0} — {1}{2}", path.basename(file), errors[0], errors.length > 1 ? vscode.l10n.t(" (+{0} more)", errors.length - 1) : ""), "error");
      return false;
    }
    this.config = config;
    return true;
  }

  private triggerLifecycle(): void {
    // Debounced: a burst of events (layout apply, Stop All) becomes one tick.
    if (this.lifecycleTrigger) clearTimeout(this.lifecycleTrigger);
    this.lifecycleTrigger = setTimeout(() => {
      void this.lifecycle.tick();
      void this.commandRunner.tick();
      this.deps.onViewsChanged("agents");
      this.deps.onViewsChanged("commands");
    }, 250);
  }

  /** the 3s heartbeat (engine events make these happen sooner, never different) */
  async tick(): Promise<void> {
    void this.lifecycle.tick();
    void this.commandRunner.tick();
    await this.monitor.tick();
    // States with durations ("idle 2m") need periodic re-render even without transitions.
    this.deps.onViewsChanged("agents");
  }

  rebuildWatches(): void {
    this.watches.dispose();
    this.watches = new WatchController(async (agent) => {
      try {
        await this.manager.restart(agent);
        notify(vscode.l10n.t("'{0}' restarted (watched file changed)", agent));
      } catch (err) {
        notify(vscode.l10n.t("watch-restart of '{0}' failed: {1}", agent, err instanceof Error ? err.message : String(err)), "error");
      }
    });
    for (const [name, def] of Object.entries(this.config?.agents ?? {})) {
      for (const glob of def.watch) {
        this.watches.watch(name, (onChange) => {
          const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.workspaceRoot, glob),
          );
          watcher.onDidChange(onChange);
          watcher.onDidCreate(onChange);
          watcher.onDidDelete(onChange);
          return () => watcher.dispose();
        });
      }
    }
  }

  async start(): Promise<void> {
    if (!this.reloadConfig()) {
      notify(vscode.l10n.t("no valid tachyon.yml in the workspace root — create one (see the Tachyon README) and run 'Tachyon: Start' again"), "warn");
      return;
    }
    // Re-discover sessions that survived a VSCode restart, then spawn pending autostarts.
    // Survivors are NOT auto-opened as tabs (hidden-tab attach renders blank).
    const surviving = await this.tmux.listSessions(`${SESSION_PREFIX}-${this.wsHash}-`);
    const pending = await this.manager.autostartPending();
    for (const agent of pending) {
      try {
        await this.manager.spawn(agent);
      } catch (err) {
        notify(vscode.l10n.t("autostart of '{0}' failed: {1}", agent, err instanceof Error ? err.message : String(err)), "error");
      }
    }
    this.rebuildWatches();
    if (surviving.length > 0) {
      notify(vscode.l10n.t("{0} surviving agent(s) re-discovered — click them in the sidebar to open", surviving.length) + (pending.length ? vscode.l10n.t("; started {0}", pending.length) : ""));
    } else if (pending.length > 0) {
      notify(vscode.l10n.t("started {0} agent(s)", pending.length));
    }
  }

  /**
   * Applies a UI-driven mutation to tachyon.yml (the file stays the source of
   * truth), then reloads config and refreshes. Surfaces warnings.
   */
  mutateConfig(
    mutate: (text: string | undefined) => { text: string; warnings: string[] },
    afterReload?: () => void,
  ): boolean {
    const file = this.configPath() ?? path.join(this.workspaceRoot, "tachyon.yml");
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    try {
      const { text, warnings } = mutate(existing);
      fs.writeFileSync(file, text, "utf8");
      this.reloadConfig();
      this.rebuildWatches();
      afterReload?.();
      for (const warning of warnings) notify(warning, "warn");
      return true;
    } catch (err) {
      notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      return false;
    }
  }

  /** F22: apply = grid + auto-spawn of stopped declared agents + focus first. */
  async applyLayoutWithSpawn(name: string, def: NonNullable<TachyonConfig["layouts"][string]>): Promise<void> {
    await applyLayout(def, this.terminals, (a) => this.manager.session(a), {
      ensureRunning: async (agent) => {
        if (!this.config?.agents[agent]) return; // ad-hoc names in a layout: nothing to spawn
        const running = await this.manager.runningAgents();
        if (running.includes(agent)) return;
        try {
          await this.manager.spawn(agent);
        } catch (err) {
          notify(vscode.l10n.t("layout '{0}': could not start '{1}': {2}", name, agent, err instanceof Error ? err.message : String(err)), "warn");
        }
      },
    });
  }

  /** settings.layout — the workspace opens already arranged. */
  async applyDefaultLayout(): Promise<void> {
    const wanted = this.config?.settings.layout;
    if (!wanted) return;
    const def = this.config?.layouts[wanted];
    if (!def) return; // parse already validated; stale only on mid-flight edits
    await this.applyLayoutWithSpawn(wanted, def);
  }

  /** Save the CURRENT editor arrangement as a named layout (capture path). */
  async saveLayoutAs(nameArg?: string, overwriteArg?: boolean): Promise<string | undefined> {
    const raw = (await vscode.commands.executeCommand("vscode.getEditorLayout")) as { orientation: number; groups: unknown[] };
    // tabGroups order == leaf (visual) order — find each group's Tachyon terminal.
    const agentsByGroup = vscode.window.tabGroups.all.map((group) => {
      const tab = group.tabs.find((t) => t.label.startsWith("⚡ "));
      return tab ? tab.label.slice(2).trim() : undefined;
    });
    const entry = captureToEntry(raw, agentsByGroup);
    if ("error" in entry) {
      notify(vscode.l10n.t("no Tachyon agent panes are open — arrange some agents first, then save"), "warn");
      return undefined;
    }
    const name =
      nameArg ??
      (await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Save the current arrangement as… (layout name)"),
        validateInput: (v) => (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(v) ? undefined : vscode.l10n.t("letters/digits/_/-, starting with a letter")),
      }));
    if (!name) return undefined;
    let overwrite = overwriteArg ?? false;
    if (!overwrite && this.config?.layouts[name]) {
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t("Layout '{0}' already exists — overwrite it?", name),
        { modal: true },
        vscode.l10n.t("Overwrite"),
      );
      if (answer !== vscode.l10n.t("Overwrite")) return undefined;
      overwrite = true;
    }
    const ok = this.mutateConfig((text) => upsertLayout(text, name, entry, overwrite), () => this.deps.onViewsChanged("layouts"));
    if (ok) notify(vscode.l10n.t("layout '{0}' saved ({1} agent(s), proportions kept)", name, entry.agents.length));
    return ok ? name : undefined;
  }

  /** Agent Studio submit pipeline — webview form and the internal test seam. */
  studioSubmit = (submit: StudioSubmit): string[] | undefined => {
    const kind = submit.state.kind;
    const taken = Object.keys(
      (kind === "command" ? this.config?.commands : kind === "runbook" ? this.config?.runbooks : this.config?.agents) ?? {},
    );
    const errors = blockingErrors(validateForm(submit.state, taken, submit.editingName));
    if (errors.length > 0) return errors.map(issueMessage);
    const entry = toEntry(submit.state);
    const ok = this.mutateConfig(
      (text) =>
        kind === "command"
          ? upsertCommand(text, submit.state.name, entry, submit.editingName)
          : kind === "runbook"
            ? upsertRunbook(text, submit.state.name, entry as { steps: string[] }, submit.editingName)
            : upsertAgent(text, submit.state.name, entry, submit.editingName),
      () => this.deps.onViewsChanged(kind === "command" || kind === "runbook" ? "commands" : "agents"),
    );
    if (!ok) return [vscode.l10n.t("could not write tachyon.yml — see the notification")];
    notify(
      kind === "command"
        ? vscode.l10n.t("command '{0}' saved — ▶ in the sidebar (or run_command) runs it", submit.state.name)
        : kind === "runbook"
          ? vscode.l10n.t("runbook '{0}' saved — ▶ in the sidebar (or run_runbook) runs it", submit.state.name)
          : vscode.l10n.t("'{0}' saved — ▶ in the sidebar starts it", submit.state.name),
    );
    return undefined;
  };

  studioDeps(): StudioDeps {
    return {
      extensionUri: this.deps.context.extensionUri,
      detectClis: detectInstalledClis,
      takenNames: () => Object.keys(this.config?.agents ?? {}),
      commandNames: () => Object.keys(this.config?.commands ?? {}),
      defaultCwd: this.workspaceRoot,
      inferKind,
      onSubmit: this.studioSubmit,
    };
  }

  openCommandPane(name: string): void {
    this.terminals.open(`cmd:${name}`, this.commandRunner.session(name), undefined, `$ ${name}`);
  }

  openRunbookStepPane(runbook: string, index: number): void {
    this.terminals.open(`rb:${runbook}:${index}`, this.runbookRunner.stepSession(runbook, index), undefined, `$ ${runbook}#${index + 1}`);
  }

  /** Folder removed from the window (or extension deactivating). tmux sessions survive. */
  async dispose(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    if (this.lifecycleTrigger) clearTimeout(this.lifecycleTrigger);
    for (const d of this.disposables) d.dispose();
    this.watches.dispose();
    this.terminals.dispose();
    this.waiters.dispose();
    await Promise.allSettled([this.bridge.dispose(), this.engine.dispose()]);
  }
}
